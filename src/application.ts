import { Context, Effect, Layer, Schema } from "effect";

import {
  MessageSchema,
  classifyFollowerMessage,
  compareSnowflakes,
  oldestFirst,
} from "./domain";
import type {
  Announcement,
  DiscordMessage,
  FollowerWebhook,
  Subscription,
} from "./domain";

const MessageIdSchema = Schema.Struct({ id: Schema.String });

/** A Discord message payload held at the REST-to-domain decoding boundary. */
export interface UnparsedDiscordMessage {
  readonly raw: unknown;
}

/** A retryable Discord REST or payload failure. */
export class DiscordApiError extends Error {
  readonly _tag = "DiscordApiError" as const;
  override readonly name = "DiscordApiError";
  readonly status: number;
  readonly retryable: boolean;
  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

/** A typed failure raised by a persistence or queue adapter. */
export class BridgeInfrastructureError extends Error {
  readonly _tag = "BridgeInfrastructureError" as const;
  override readonly name = "BridgeInfrastructureError";
  readonly operation: string;
  override readonly cause: unknown;
  constructor(operation: string, cause: unknown) {
    super(`Bridge infrastructure operation failed: ${operation}`);
    this.operation = operation;
    this.cause = cause;
  }
}

/** A follower crosspost has no readable content-bearing fields. */
export class AnnouncementContentUnavailableError extends Error {
  readonly _tag = "AnnouncementContentUnavailable";
  override readonly name = "AnnouncementContentUnavailableError";
  readonly messageId: string;
  constructor(messageId: string) {
    super(
      "Discord withheld announcement content; enable MESSAGE_CONTENT and retry"
    );
    this.messageId = messageId;
  }
}

/** Identifier for one durable queue delivery. */
export interface DeliveryRef {
  readonly deliveryId: string;
  readonly announcementId: string;
}

/** Ports required by the polling use case. */
export interface PollingPorts {
  readonly source: {
    readonly fetchAfter: (
      channelId: string,
      after: string
    ) => Effect.Effect<readonly UnparsedDiscordMessage[], DiscordApiError>;
    readonly fetchBefore: (
      channelId: string,
      before: string
    ) => Effect.Effect<readonly UnparsedDiscordMessage[], DiscordApiError>;
    readonly fetchLatest: (
      channelId: string
    ) => Effect.Effect<readonly UnparsedDiscordMessage[], DiscordApiError>;
    readonly getWebhook: (
      webhookId: string
    ) => Effect.Effect<FollowerWebhook | undefined, DiscordApiError>;
  };
  readonly repository: {
    readonly enabledSubscriptions: () => Effect.Effect<
      readonly Subscription[],
      BridgeInfrastructureError
    >;
    readonly cursor: (
      subscriptionId: string
    ) => Effect.Effect<string | undefined, BridgeInfrastructureError>;
    readonly initializeCursor: (
      subscriptionId: string,
      messageId: string | undefined
    ) => Effect.Effect<void, BridgeInfrastructureError>;
    readonly persistDiscoveryBatch: (
      subscription: Subscription,
      announcements: readonly Announcement[],
      cursor: string | undefined
    ) => Effect.Effect<void, BridgeInfrastructureError>;
    readonly pendingDeliveries: (
      subscriptionId: string
    ) => Effect.Effect<readonly DeliveryRef[], BridgeInfrastructureError>;
    readonly markEnqueued: (
      deliveryId: string
    ) => Effect.Effect<void, BridgeInfrastructureError>;
  };
  readonly enqueue: (
    delivery: DeliveryRef
  ) => Effect.Effect<void, BridgeInfrastructureError>;
}

/** Effect service contract for announcement polling and durable discovery. */
export class PollingService extends Context.Service<
  PollingService,
  PollingPorts
>()("discord-email/PollingService") {}

/** Test or production implementation layer for polling. */
export const pollingServiceLayer = (
  ports: PollingPorts
): Layer.Layer<PollingService> => Layer.succeed(PollingService, ports);

/** Poll all enabled subscriptions, persist discoveries/cursors, then enqueue identifiers. */
export const pollAll = Effect.gen(function* pollAll() {
  const ports = yield* PollingService;
  const subscriptions = yield* ports.repository.enabledSubscriptions();
  for (const subscription of subscriptions) {
    yield* pollSubscription(ports, subscription);
  }
});

function pollSubscription(ports: PollingPorts, subscription: Subscription) {
  return Effect.gen(function* pollSubscriptionEffect() {
    const cursor = yield* ports.repository.cursor(subscription.id);
    if (cursor === undefined) {
      yield* initializeCursor(ports, subscription);
      return;
    }
    const history = yield* fetchHistory(ports, subscription, cursor);
    const announcements = yield* classifyMessages(
      ports,
      subscription,
      history.messages
    );
    yield* persistAndEnqueue(
      ports,
      subscription,
      announcements,
      history.highWater
    );
  });
}

function initializeCursor(ports: PollingPorts, subscription: Subscription) {
  return Effect.gen(function* initializeCursorEffect() {
    const latest = yield* ports.source.fetchLatest(
      subscription.destinationChannelId
    );
    const ids = latest.flatMap((payload) => {
      const parsed = Schema.decodeUnknownOption(MessageIdSchema)(payload.raw);
      return parsed._tag === "Some" && /^\d+$/u.test(parsed.value.id)
        ? [parsed.value.id]
        : [];
    });
    yield* ports.repository.initializeCursor(
      subscription.id,
      ids.toSorted(compareSnowflakes).at(-1)
    );
  });
}

function fetchHistory(
  ports: PollingPorts,
  subscription: Subscription,
  cursor: string
) {
  return Effect.gen(function* fetchHistoryEffect() {
    let highWater = cursor;
    const messages: DiscordMessage[] = [];
    const firstPage = yield* ports.source.fetchAfter(
      subscription.destinationChannelId,
      cursor
    );
    let page = firstPage;
    for (;;) {
      const pageMessages: DiscordMessage[] = [];
      for (const payload of page) {
        const parsedId = Schema.decodeUnknownOption(MessageIdSchema)(
          payload.raw
        );
        const rawId =
          parsedId._tag === "Some" && /^\d+$/u.test(parsedId.value.id)
            ? parsedId.value.id
            : undefined;
        if (rawId && compareSnowflakes(rawId, highWater) > 0) {
          highWater = rawId;
        }
        const decoded = yield* Schema.decodeUnknownEffect(MessageSchema)(
          payload.raw
        ).pipe(Effect.option);
        if (decoded._tag === "Some") {
          pageMessages.push(decoded.value);
        }
      }
      messages.push(
        ...pageMessages.filter(
          (message) => compareSnowflakes(message.id, cursor) > 0
        )
      );
      const ids = page
        .flatMap((payload) => {
          const parsed = Schema.decodeUnknownOption(MessageIdSchema)(
            payload.raw
          );
          return parsed._tag === "Some" && /^\d+$/u.test(parsed.value.id)
            ? [parsed.value.id]
            : [];
        })
        .toSorted(compareSnowflakes);
      const [oldest] = ids;
      if (
        !oldest ||
        page.length < 100 ||
        compareSnowflakes(oldest, cursor) <= 0
      ) {
        break;
      }
      page = yield* ports.source.fetchBefore(
        subscription.destinationChannelId,
        oldest
      );
    }
    return { highWater, messages: oldestFirst(messages) };
  });
}

function classifyMessages(
  ports: PollingPorts,
  subscription: Subscription,
  messages: readonly DiscordMessage[]
) {
  return Effect.gen(function* classifyMessagesEffect() {
    const announcements: Announcement[] = [];
    const webhooks = new Map<string, FollowerWebhook | undefined>();
    for (const message of messages) {
      if (!message.webhook_id || ((message.flags ?? 0) & 2) === 0) {
        continue;
      }
      let webhook = webhooks.get(message.webhook_id);
      if (!webhooks.has(message.webhook_id)) {
        webhook = yield* ports.source.getWebhook(message.webhook_id).pipe(
          Effect.catchIf(
            (error) => error.status === 404,
            () => Effect.succeed<undefined>(undefined)
          )
        );
        webhooks.set(message.webhook_id, webhook);
      }
      const announcement = classifyFollowerMessage(
        message,
        webhook,
        subscription
      );
      if (announcement) {
        if (
          !message.content &&
          message.embeds.length === 0 &&
          message.attachments.length === 0
        ) {
          return yield* Effect.fail(
            new AnnouncementContentUnavailableError(message.id)
          );
        }
        announcements.push(announcement);
      }
    }
    return announcements;
  });
}

function persistAndEnqueue(
  ports: PollingPorts,
  subscription: Subscription,
  announcements: readonly Announcement[],
  highWater: string
) {
  return Effect.gen(function* persistAndEnqueueEffect() {
    // Persist all discoveries and the high-water mark before queueing. The repository
    // implementation uses D1 uniqueness constraints and a transaction/batch.
    yield* ports.repository.persistDiscoveryBatch(
      subscription,
      announcements,
      highWater
    );
    const pending = yield* ports.repository.pendingDeliveries(subscription.id);
    for (const delivery of pending) {
      yield* ports.enqueue(delivery);
      yield* ports.repository.markEnqueued(delivery.deliveryId);
    }
  });
}
