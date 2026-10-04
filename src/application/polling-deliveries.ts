import { Effect } from "effect";

import type { PollingPorts } from "@/application/polling";
import type { Announcement, Subscription } from "@/domain";

/**
 * Persist a discovery batch and cursor in bounded D1 batches, then enqueue
 * pending delivery IDs and mark each successful enqueue for retry recovery.
 * @param ports - Repository and queue operations for this poll.
 * @param subscription - Subscription being polled.
 * @param announcements - Newly verified announcements to persist.
 * @param highWater - Greatest message ID observed during history retrieval.
 * @returns An Effect that persists discoveries and enqueues pending deliveries.
 */
export const persistAndEnqueue = (
  ports: PollingPorts,
  subscription: Subscription,
  announcements: readonly Announcement[],
  highWater: string
) =>
  Effect.gen(function* persistAndEnqueueEffect() {
    yield* ports.repository.persistDiscoveryBatch(
      subscription,
      announcements,
      highWater
    );
    const pending = yield* ports.repository.pendingDeliveries();
    for (const delivery of pending) {
      yield* ports.enqueue(delivery);
      yield* ports.repository.markEnqueued(delivery.deliveryId);
    }
  });
