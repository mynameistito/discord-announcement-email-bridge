import { Context, Effect, Layer } from "effect";

import { pollSubscription } from "@/application/polling-subscription";
import type { BridgeInfrastructureError } from "@/bridge-infrastructure-error";
import type { DiscordApiError } from "@/discord-api-error";
import type { Announcement, FollowerWebhook, Subscription } from "@/domain";

/** Raw Discord data retained until application-level schema validation. */
export interface UnparsedDiscordMessage {
  readonly raw: unknown;
}

/** Stable identifiers needed to enqueue and later resolve one email delivery. */
export interface DeliveryRef {
  readonly deliveryId: string;
  readonly announcementId: string;
}

/**
 * Discord reads, durable repository operations, and queue enqueueing required
 * by the polling use case; implementations keep infrastructure outside domain logic.
 */
export interface PollingPorts {
  /** Discord REST reads and webhook metadata required to classify messages. */
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
  /** Durable cursor, discovery, and pending-delivery repository operations. */
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
  /** Publish a durable delivery identifier to the asynchronous queue. */
  readonly enqueue: (
    delivery: DeliveryRef
  ) => Effect.Effect<void, BridgeInfrastructureError>;
}

/** Effect service tag for dependency injection of polling ports. */
export class PollingService extends Context.Service<
  PollingService,
  PollingPorts
>()("discord-email/PollingService") {}

/**
 * Bind a concrete polling port implementation to the Effect service tag.
 * @param ports - Concrete infrastructure operations for polling.
 * @returns A Layer providing the polling service.
 */
export const pollingServiceLayer = (
  ports: PollingPorts
): Layer.Layer<PollingService> => Layer.succeed(PollingService, ports);

/**
 * Poll each enabled subscription, collecting per-subscription failures while
 * allowing independent subscriptions to finish their discovery work.
 */
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
