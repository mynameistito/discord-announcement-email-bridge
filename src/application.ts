import { Context, Effect, Layer } from "effect";

import {
  classifyFollowerMessage,
  compareSnowflakes,
  decodeMessage,
  oldestFirst,
} from "./domain";
import type {
  Announcement,
  DiscordMessage,
  FollowerWebhook,
  Subscription,
} from "./domain";

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
    ) => Effect.Effect<readonly unknown[], DiscordApiError>;
    readonly fetchBefore: (
      channelId: string,
      before: string
    ) => Effect.Effect<readonly unknown[], DiscordApiError>;
    readonly fetchLatest: (
      channelId: string
    ) => Effect.Effect<readonly unknown[], DiscordApiError>;
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
export const PollingServiceLayer = (
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
      const latest = yield* ports.source.fetchLatest(
        subscription.destinationChannelId
      );
      const ids = latest
        .flatMap(readMessageId)
        .filter((id): id is string => id !== undefined);
      const lastId = ids.toSorted(compareSnowflakes).at(-1);
      yield* ports.repository.initializeCursor(subscription.id, lastId);
      return;
    }
    let highWater = cursor;
    let hasMore = true;
    const decoded: DiscordMessage[] = [];
    const firstPage = yield* ports.source.fetchAfter(
      subscription.destinationChannelId,
      cursor
    );
    let page = firstPage;
    while (hasMore) {
      const messages: DiscordMessage[] = [];
      for (const payload of page) {
        const rawId = readMessageId(payload);
        if (rawId && compareSnowflakes(rawId, highWater) > 0) {
          highWater = rawId;
        }
        const message = yield* decodeMessage(payload).pipe(
          Effect.catch(() => Effect.succeed<undefined>(undefined))
        );
        if (message) {
          messages.push(message);
        }
      }
      decoded.push(
        ...messages.filter(
          (message) => compareSnowflakes(message.id, cursor) > 0
        )
      );
      const ids = page
        .flatMap(readMessageId)
        .filter((id): id is string => id !== undefined)
        .toSorted(compareSnowflakes);
      const [oldest] = ids;
      if (
        !oldest ||
        page.length < 100 ||
        compareSnowflakes(oldest, cursor) <= 0
      ) {
        break;
      }
      hasMore = true;
      page = yield* ports.source.fetchBefore(
        subscription.destinationChannelId,
        oldest
      );
    }

    const announcements: Announcement[] = [];
    const webhooks = new Map<string, FollowerWebhook | undefined>();
    for (const message of oldestFirst(decoded)) {
      if (!message.webhook_id || ((message.flags ?? 0) & 2) === 0) {
        continue;
      }
      let webhook = webhooks.get(message.webhook_id);
      if (!webhooks.has(message.webhook_id)) {
        webhook = yield* ports.source
          .getWebhook(message.webhook_id)
          .pipe(
            Effect.catch((error) =>
              error.status === 404
                ? Effect.succeed<undefined>(undefined)
                : Effect.fail(error)
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

function readMessageId(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null || !("id" in input)) {
    return undefined;
  }
  const { id } = input;
  return typeof id === "string" && /^\d+$/u.test(id) ? id : undefined;
}
