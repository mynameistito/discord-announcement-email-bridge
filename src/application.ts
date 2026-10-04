import { Context, Effect, Layer, Schema } from "effect";

import type { BridgeInfrastructureError } from "./bridge-infrastructure-error";
import { DiscordApiError } from "./discord-api-error";
import {
  MessageSchema,
  classifyFollowerMessage,
  compareSnowflakes,
  hasCrosspostFlag,
  oldestFirst,
} from "./domain";
import type {
  Announcement,
  DiscordMessage,
  FollowerWebhook,
  Subscription,
} from "./domain";

const MessageIdSchema = Schema.Struct({ id: Schema.String });
const PotentialCrosspostSchema = Schema.Struct({
  flags: Schema.Number,
  webhook_id: Schema.String,
});

/** A Discord message payload held at the REST-to-domain decoding boundary. */
export interface UnparsedDiscordMessage {
  readonly raw: unknown;
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
    ) => Effect.Effect<FollowerWebhook | null, DiscordApiError>;
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
export function pollingServiceLayer(
  ports: PollingPorts
): Layer.Layer<PollingService> {
  return Layer.succeed(PollingService, ports);
}

/** Poll all enabled subscriptions, persist discoveries/cursors, then enqueue identifiers. */
export const pollAll = Effect.gen(function* pollAll() {
  const ports = yield* PollingService;
  const subscriptions = yield* ports.repository.enabledSubscriptions();
  const failures: string[] = [];
  for (const subscription of subscriptions) {
    const failure = yield* pollSubscription(ports, subscription).pipe(
      Effect.match({
        onFailure: (error) => `${subscription.id}: ${error.message}`,
        onSuccess: () => "",
      })
    );
    if (failure) {
      failures.push(failure);
    }
  }
  if (failures.length > 0) {
    return yield* Effect.fail(
      new Error(`Polling failed: ${failures.join("; ")}`)
    );
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
      ids.toSorted(compareSnowflakes).at(-1) ?? "0"
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
        const decoded = decodePolledMessage(payload);
        if (decoded.id && compareSnowflakes(decoded.id, highWater) > 0) {
          highWater = decoded.id;
        }
        if (
          decoded._tag === "MalformedCrosspost" &&
          (!decoded.id || compareSnowflakes(decoded.id, cursor) > 0)
        ) {
          return yield* Effect.fail(decoded.error);
        }
        if (decoded._tag === "Message") {
          pageMessages.push(decoded.message);
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

type DecodedPolledMessage =
  | {
      readonly _tag: "Message";
      readonly id: string;
      readonly message: DiscordMessage;
    }
  | {
      readonly _tag: "MalformedCrosspost";
      readonly id?: string;
      readonly error: DiscordApiError;
    }
  | { readonly _tag: "Skip"; readonly id?: string };

function decodePolledMessage(
  payload: UnparsedDiscordMessage
): DecodedPolledMessage {
  const parsedId = Schema.decodeUnknownOption(MessageIdSchema)(payload.raw);
  const id =
    parsedId._tag === "Some" && /^\d+$/u.test(parsedId.value.id)
      ? parsedId.value.id
      : undefined;
  const message = Schema.decodeUnknownOption(MessageSchema)(payload.raw);
  if (message._tag === "Some") {
    return { _tag: "Message", id: message.value.id, message: message.value };
  }
  const possibleCrosspost = Schema.decodeUnknownOption(
    PotentialCrosspostSchema
  )(payload.raw);
  if (
    possibleCrosspost._tag === "Some" &&
    hasCrosspostFlag(possibleCrosspost.value.flags)
  ) {
    return {
      _tag: "MalformedCrosspost",
      ...(id ? { id } : undefined),
      error: new DiscordApiError(
        "Discord returned a malformed crosspost candidate",
        502,
        false
      ),
    };
  }
  return { _tag: "Skip", ...(id ? { id } : undefined) };
}

function classifyMessages(
  ports: PollingPorts,
  subscription: Subscription,
  messages: readonly DiscordMessage[]
) {
  return Effect.gen(function* classifyMessagesEffect() {
    const announcements: Announcement[] = [];
    const webhooks = new Map<string, FollowerWebhook | null>();
    for (const message of messages) {
      if (message.webhook_id && hasCrosspostFlag(message.flags ?? 0)) {
        let webhook = webhooks.get(message.webhook_id) ?? null;
        if (!webhooks.has(message.webhook_id)) {
          webhook = yield* ports.source.getWebhook(message.webhook_id).pipe(
            Effect.catchIf(
              (error) => error.status === 404,
              () => Effect.succeed(null)
            )
          );
          webhooks.set(message.webhook_id, webhook);
        }
        const announcement = classifyFollowerMessage(
          message,
          webhook,
          subscription
        );
        if (announcement && hasReadableContent(message)) {
          announcements.push(announcement);
        } else if (announcement) {
          console.warn(
            JSON.stringify({
              event: "announcement.content_unavailable",
              messageId: message.id,
              subscriptionId: subscription.id,
            })
          );
        }
      }
    }
    return announcements;
  });
}

function hasReadableContent(message: DiscordMessage): boolean {
  return (
    Boolean(message.content) ||
    message.embeds.length > 0 ||
    message.attachments.length > 0
  );
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
