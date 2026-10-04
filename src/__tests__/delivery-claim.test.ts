import { Deferred, Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { QueueOperations } from "@/adapters/queue";
import { processQueue } from "@/adapters/queue";

const deliveryId = "delivery-123";
const announcementId = "announcement-123";
const payload = { announcementId, deliveryId };

/** Mutable observations collected by the queue-level delivery test. */
interface DeliveryCounters {
  /** Number of claim attempts made for the duplicate messages. */
  claims: number;
  /** Number of times the email side effect started. */
  sends: number;
  /** Current in-memory delivery state. */
  status: "queued" | "sending" | "sent";
  /** Number of messages acknowledged by the queue adapter. */
  acknowledgements: number;
  /** Number of messages retried by the queue adapter. */
  retries: number;
}

/**
 * Create an in-memory queue operation set that permits one active owner.
 * @param started - Deferred signal indicating that sending has started.
 * @param release - Deferred signal allowing the send to finish.
 * @param bothClaims - Deferred signal indicating both queue items tried claiming.
 * @param counters - Mutable observations updated by queue operations.
 * @returns Queue operations backed by the in-memory state.
 */
const makeQueueOperations = (
  started: Deferred.Deferred<boolean>,
  release: Deferred.Deferred<boolean>,
  bothClaims: Deferred.Deferred<boolean>,
  counters: DeliveryCounters
): QueueOperations => ({
  claimDelivery: () =>
    Effect.gen(function* claimDelivery() {
      counters.claims += 1;
      let claim: "claimed" | "complete" | "in_flight";
      if (counters.status === "sent") {
        claim = "complete";
      } else if (counters.status === "sending") {
        claim = "in_flight";
      } else {
        claim = "claimed";
      }
      if (claim === "claimed") {
        counters.status = "sending";
      }
      if (counters.claims === 2) {
        yield* Deferred.succeed(bothClaims, true);
      }
      return claim;
    }),
  delivery: () =>
    Effect.gen(function* sendClaimedDelivery() {
      counters.sends += 1;
      yield* Deferred.succeed(started, true);
      yield* Deferred.await(release);
      counters.status = "sent";
    }),
  failDeadLetter: () => Effect.succeed(false),
  recordFailure: () => Effect.void,
  safeError: () => "test failure",
});

/**
 * Build a correctly typed queue message with the given retry callback.
 * @param acknowledge - Callback invoked when the message is acknowledged.
 * @param retry - Callback invoked when the message is retried.
 * @returns A Cloudflare queue message for the test batch.
 */
const queueMessage = (
  acknowledge: () => void,
  retry: () => void
): Message<unknown> => ({
  ack: acknowledge,
  attempts: 1,
  body: payload,
  id: "queue-message",
  retry,
  timestamp: new Date(),
});

/**
 * Build a batch whose shape matches the Cloudflare queue binding contract.
 * @param messages - Messages included in the batch.
 * @param counters - Mutable observations updated by batch acknowledgements.
 * @returns A Cloudflare queue batch for tests.
 */
const queueBatch = (
  messages: readonly Message<unknown>[],
  counters: DeliveryCounters
): MessageBatch<unknown> => ({
  ackAll: () => {
    counters.acknowledgements += 1;
  },
  messages,
  metadata: { metrics: { backlogBytes: 0, backlogCount: messages.length } },
  queue: "delivery-queue",
  retryAll: () => {
    counters.retries += 1;
  },
});

describe("delivery claim", () => {
  it("sends once when duplicate queue messages arrive concurrently", async () => {
    const started = await Effect.runPromise(Deferred.make<boolean>());
    const release = await Effect.runPromise(Deferred.make<boolean>());
    const bothClaims = await Effect.runPromise(Deferred.make<boolean>());
    const counters: DeliveryCounters = {
      acknowledgements: 0,
      claims: 0,
      retries: 0,
      sends: 0,
      status: "queued",
    };
    const operations = makeQueueOperations(
      started,
      release,
      bothClaims,
      counters
    );
    const batch = queueBatch(
      [
        queueMessage(
          () => {
            counters.acknowledgements += 1;
          },
          () => {
            counters.retries += 1;
          }
        ),
        queueMessage(
          () => {
            counters.acknowledgements += 1;
          },
          () => {
            counters.retries += 1;
          }
        ),
      ],
      counters
    );

    const processing = processQueue(batch, "dead-letter", operations);
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Deferred.await(bothClaims));

    expect(counters.sends).toBe(1);
    expect(counters.retries).toBe(1);

    await Effect.runPromise(Deferred.succeed(release, true));
    await processing;

    expect(counters.status).toBe("sent");
  });

  it("retries an active claim and sends after its lease is recovered", async () => {
    const started = await Effect.runPromise(Deferred.make<boolean>());
    const release = await Effect.runPromise(Deferred.make<boolean>());
    const bothClaims = await Effect.runPromise(Deferred.make<boolean>());
    const counters: DeliveryCounters = {
      acknowledgements: 0,
      claims: 0,
      retries: 0,
      sends: 0,
      status: "sending",
    };
    const operations = makeQueueOperations(
      started,
      release,
      bothClaims,
      counters
    );
    const makeBatch = () =>
      queueBatch(
        [
          queueMessage(
            () => {
              counters.acknowledgements += 1;
            },
            () => {
              counters.retries += 1;
            }
          ),
        ],
        counters
      );

    await processQueue(makeBatch(), "dead-letter", operations);

    expect(counters.sends).toBe(0);
    expect(counters.retries).toBe(1);

    // D1 recovery clears an expired claim and makes its queued delivery claimable.
    counters.status = "queued";
    const processing = processQueue(makeBatch(), "dead-letter", operations);
    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Deferred.succeed(release, true));
    await processing;

    expect(counters.sends).toBe(1);
    expect(counters.status).toBe("sent");
  });
});
