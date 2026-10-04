import { Effect } from "effect";

import {
  claimDelivery as claimDeliveryInD1,
  makeRepository,
  markDeadLetter,
  updateDeliveryFailure,
} from "@/adapters/d1";
import { makeDiscordSource } from "@/adapters/discord";
import { processQueue } from "@/adapters/queue";
import type { QueueOperations } from "@/adapters/queue";
import type { WorkerEnv } from "@/alchemy.run";
import {
  adminResponse as createAdminResponse,
  safeError,
  seedSubscription,
  subscriptionFromEnv,
} from "@/application/admin";
import { deliver } from "@/application/delivery";
import { pollingServiceLayer, pollAll } from "@/application/polling";
import { BridgeInfrastructureError } from "@/bridge-infrastructure-error";

/**
 * Seed the configured subscription, compose its ports, and run all polling
 * work while returning a sanitized status for cron and admin callers.
 */
export const poll = async (
  env: WorkerEnv
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> => {
  const subscription = subscriptionFromEnv(env);
  if (!subscription) {
    return { error: "required_configuration_missing", ok: false };
  }
  const seeded = await seedSubscription(env, subscription);
  if (seeded._tag === "Failure") {
    return { error: safeError(seeded.cause), ok: false };
  }
  const ports = {
    enqueue: (delivery: {
      readonly announcementId: string;
      readonly deliveryId: string;
    }) =>
      Effect.tryPromise({
        catch: (cause) => new BridgeInfrastructureError("queue_send", cause),
        try: () => env.DELIVERY_QUEUE.send(delivery),
      }).pipe(Effect.asVoid),
    repository: makeRepository(env),
    source: makeDiscordSource(env),
  };
  const result = await Effect.runPromiseExit(
    pollAll.pipe(Effect.provide(pollingServiceLayer(ports)))
  );
  return result._tag === "Success"
    ? { ok: true }
    : { error: safeError(result.cause), ok: false };
};

/** Delegate one already-claimed delivery to the application delivery use case. */
export const delivery = (
  env: WorkerEnv,
  claimToken: string,
  deliveryId: string,
  announcementId: string
) => deliver(env, claimToken, deliveryId, announcementId);

/**
 * Bind queue processing to environment-backed D1 claims, email delivery,
 * failure recording, and dead-letter handling.
 */
export const consumeQueue = (batch: MessageBatch<unknown>, env: WorkerEnv) => {
  const operations: QueueOperations = {
    claimDelivery: (deliveryId, announcementId, claimToken) =>
      claimDeliveryInD1(env, deliveryId, announcementId, claimToken),
    delivery: (claimToken, deliveryId, announcementId) =>
      deliver(env, claimToken, deliveryId, announcementId),
    failDeadLetter: (deliveryId) => markDeadLetter(env, deliveryId),
    recordFailure: (deliveryId, message, retryable, claimToken) =>
      updateDeliveryFailure(env, deliveryId, message, retryable, claimToken),
    safeError,
  };
  return processQueue(batch, env.DELIVERY_DEAD_LETTER_QUEUE_NAME, operations);
};

/** Claim a delivery atomically before running its external email side effect. */
export const claimDelivery = (
  env: WorkerEnv,
  deliveryId: string,
  announcementId: string,
  claimToken: string
) => claimDeliveryInD1(env, deliveryId, announcementId, claimToken);

/** Record a failed attempt while guarding the update with its claim token. */
export const recordFailure = (
  env: WorkerEnv,
  id: string,
  message: string,
  retryable: boolean,
  claimToken: string
) => updateDeliveryFailure(env, id, message, retryable, claimToken);

/** Mark a delivery failed when the platform moves it to the dead-letter queue. */
export const failDeadLetter = (env: WorkerEnv, id: string) =>
  markDeadLetter(env, id);

/** Route an authorized HTTP request through the application admin handlers. */
export const adminResponse = (
  method: string,
  pathname: string,
  env: WorkerEnv
) => createAdminResponse(method, pathname, env, poll);

/** Re-export the safe error renderer for worker queue logging. */
export { safeError } from "@/application/admin";
