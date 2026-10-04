import { Cause, Effect, Schema } from "effect";

import type { WorkerEnv } from "@/alchemy.run";
import { ApiError } from "@/application/delivery-error";
import { BridgeInfrastructureError } from "@/bridge-infrastructure-error";
import { DiscordApiError } from "@/discord-api-error";

/** Runtime validator for the minimal durable delivery message payload. */
const QueuePayloadSchema = Schema.Struct({
  announcementId: Schema.String,
  deliveryId: Schema.String,
});

/** The ownership outcome returned by the delivery claim boundary. */
export type DeliveryClaim = "claimed" | "complete" | "in_flight";

/** Operations required by the queue adapter to process delivery messages. */
export interface QueueOperations {
  /** Atomically claim a delivery before its email side effect. */
  readonly claimDelivery: (
    deliveryId: string,
    announcementId: string,
    claimToken: string
  ) => Effect.Effect<DeliveryClaim, unknown>;
  /** Send a delivery that the caller has already claimed. */
  readonly delivery: (
    claimToken: string,
    deliveryId: string,
    announcementId: string
  ) => Effect.Effect<void, unknown>;
  /** Mark a delivery failed when a message reaches the dead-letter queue. */
  readonly failDeadLetter: (
    deliveryId: string
  ) => Effect.Effect<boolean, unknown>;
  /** Persist the outcome of a failed attempt owned by the supplied claim. */
  readonly recordFailure: (
    deliveryId: string,
    error: string,
    retryable: boolean,
    claimToken: string
  ) => Effect.Effect<void, unknown>;
  /** Render an Effect failure as a safe message suitable for queue logs. */
  readonly safeError: (cause: Cause.Cause<unknown>) => string;
}

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

/**
 * Process delivery or dead-letter messages from a Cloudflare queue batch.
 *
 * @param batch - The Cloudflare queue batch to process.
 * @param deadLetterQueueName - The configured queue name used to detect dead letters.
 * @param operations - The persistence and delivery operations wired by composition.
 * @returns A promise that resolves after each message is acknowledged or retried.
 */
export const processQueue = async (
  batch: MessageBatch<unknown>,
  deadLetterQueueName: WorkerEnv["DELIVERY_DEAD_LETTER_QUEUE_NAME"],
  operations: QueueOperations
): Promise<void> => {
  await Promise.all(
    batch.messages.map(async (message) => {
      const payload = Schema.decodeUnknownOption(QueuePayloadSchema)(
        message.body
      );
      if (payload._tag === "None") {
        const deadLetter = batch.queue === deadLetterQueueName;
        console.error(
          JSON.stringify({
            event: deadLetter
              ? "queue.invalid_dead_letter"
              : "queue.invalid_message",
          })
        );
        return;
      }
      if (batch.queue === deadLetterQueueName) {
        const exit = await Effect.runPromiseExit(
          operations.failDeadLetter(payload.value.deliveryId)
        );
        if (exit._tag === "Failure") {
          console.error(
            JSON.stringify({ event: "delivery.dead_letter_failed" })
          );
          message.retry({ delaySeconds: 60 });
          return;
        }
        console.error(
          JSON.stringify({
            event: exit.value
              ? "delivery.dead_lettered"
              : "delivery.dead_letter_deferred",
          })
        );
        return;
      }
      const claimToken = crypto.randomUUID();
      const claim = await Effect.runPromiseExit(
        operations.claimDelivery(
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
        operations.delivery(
          claimToken,
          payload.value.deliveryId,
          payload.value.announcementId
        )
      );
      if (result._tag === "Success") {
        return;
      }

      const errorMessage = operations.safeError(result.cause);
      const retryable = isRetryable(result.cause);
      const recorded = await Effect.runPromiseExit(
        operations.recordFailure(
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
