import { Effect } from "effect";

import type { PollingPorts } from "@/application/polling";
import type { Announcement, Subscription } from "@/domain";

/**
 * Persist a discovery batch and cursor atomically, then enqueue pending delivery
 * IDs and mark each successfully enqueued row for durable retry recovery.
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
    const pending = yield* ports.repository.pendingDeliveries(subscription.id);
    for (const delivery of pending) {
      yield* ports.enqueue(delivery);
      yield* ports.repository.markEnqueued(delivery.deliveryId);
    }
  });
