import { Cause, Effect, Schema } from "effect";

import type { WorkerEnv } from "@/alchemy.run";
import { ApiError } from "@/application/delivery-error";
import { BridgeInfrastructureError } from "@/bridge-infrastructure-error";
import {
  claimDelivery,
  delivery,
  failDeadLetter,
  recordFailure,
  safeError,
} from "@/composition";
import { DiscordApiError } from "@/discord-api-error";

const QueuePayloadSchema = Schema.Struct({
  announcementId: Schema.String,
  deliveryId: Schema.String,
});

const isRetryable = (cause: Cause.Cause<unknown>): boolean => {
  const failure = Cause.findErrorOption(cause);
  if (failure._tag === "None") {
    return false;
  }
  const error = failure.value;
  return error instanceof DiscordApiError ||
    error instanceof BridgeInfrastructureError ||
    error instanceof ApiError
    ? error.retryable
    : false;
};

/** Process delivery or dead-letter messages from a Cloudflare queue batch. */
export const processQueue = async (
  batch: MessageBatch<unknown>,
  env: WorkerEnv
): Promise<void> => {
  await Promise.all(
    batch.messages.map(async (message) => {
      const payload = Schema.decodeUnknownOption(QueuePayloadSchema)(
        message.body
      );
      if (payload._tag === "None") {
        const deadLetter = batch.queue === env.DELIVERY_DEAD_LETTER_QUEUE_NAME;
        console.error(
          JSON.stringify({
            event: deadLetter
              ? "queue.invalid_dead_letter"
              : "queue.invalid_message",
          })
        );
        return;
      }
      if (batch.queue === env.DELIVERY_DEAD_LETTER_QUEUE_NAME) {
        const failed = await Effect.runPromise(
          failDeadLetter(env, payload.value.deliveryId)
        );
        console.error(
          JSON.stringify({
            event: failed
              ? "delivery.dead_lettered"
              : "delivery.dead_letter_deferred",
          })
        );
        return;
      }
      const claimToken = crypto.randomUUID();
      const claim = await Effect.runPromiseExit(
        claimDelivery(
          env,
          payload.value.deliveryId,
          payload.value.announcementId,
          claimToken
        )
      );
      if (claim._tag === "Failure") {
        console.error(JSON.stringify({ event: "delivery.claim_failed" }));
        message.retry({ delaySeconds: 60 });
        return;
      }
      if (claim.value === "complete") {
        return;
      }
      if (claim.value === "in_flight") {
        message.retry({ delaySeconds: 60 });
        return;
      }
      const result = await Effect.runPromiseExit(
        delivery(
          env,
          claimToken,
          payload.value.deliveryId,
          payload.value.announcementId
        )
      );
      if (result._tag === "Success") {
        return;
      }

      const errorMessage = safeError(result.cause);
      const retryable = isRetryable(result.cause);
      const recorded = await Effect.runPromiseExit(
        recordFailure(
          env,
          payload.value.deliveryId,
          errorMessage,
          retryable,
          claimToken
        )
      );
      if (recorded._tag === "Failure") {
        console.error(
          JSON.stringify({
            event: "delivery.record_failed",
          })
        );
        message.retry({ delaySeconds: 60 });
      } else if (retryable) {
        console.warn(
          JSON.stringify({
            attempt: message.attempts,
            error: errorMessage,
            event: "delivery.retry",
          })
        );
        message.retry({ delaySeconds: 60 });
      } else {
        console.error(
          JSON.stringify({
            error: errorMessage,
            event: "delivery.failed",
          })
        );
      }
    })
  );
};
