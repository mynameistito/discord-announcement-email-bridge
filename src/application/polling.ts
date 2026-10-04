import { Context, Effect, Layer } from "effect";

import { pollSubscription } from "@/application/polling-subscription";
import type { BridgeInfrastructureError } from "@/bridge-infrastructure-error";
import type { DiscordApiError } from "@/discord-api-error";
import type { Announcement, FollowerWebhook, Subscription } from "@/domain";

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
export const pollingServiceLayer = (
  ports: PollingPorts
): Layer.Layer<PollingService> => Layer.succeed(PollingService, ports);

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
