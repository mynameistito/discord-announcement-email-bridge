import { Effect } from "effect";

import {
  claimDelivery as claimDeliveryInD1,
  makeRepository,
  markDeadLetter,
  updateDeliveryFailure,
} from "@/adapters/d1";
import { makeDiscordSource } from "@/adapters/discord";
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

export const delivery = (
  env: WorkerEnv,
  claimToken: string,
  deliveryId: string,
  announcementId: string
) => deliver(env, claimToken, deliveryId, announcementId);

/** Claim a delivery before running its external email side effect. */
export const claimDelivery = (
  env: WorkerEnv,
  deliveryId: string,
  announcementId: string,
  claimToken: string
) => claimDeliveryInD1(env, deliveryId, announcementId, claimToken);

export const recordFailure = (
  env: WorkerEnv,
  id: string,
  message: string,
  retryable: boolean,
  claimToken: string
) => updateDeliveryFailure(env, id, message, retryable, claimToken);
export const failDeadLetter = (env: WorkerEnv, id: string) =>
  markDeadLetter(env, id);

export const adminResponse = (
  method: string,
  pathname: string,
  env: WorkerEnv
) => createAdminResponse(method, pathname, env, poll);
export { safeError } from "@/application/admin";
