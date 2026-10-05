import { Effect } from "effect";

import { d1 } from "@/adapters/d1";
import type { WorkerEnv } from "@/alchemy.run";

/**
 * Record a failed attempt only while its lease token still owns the delivery.
 * Clears the lease and returns retryable failures to the queue state.
 * @param env - Worker bindings including the D1 database.
 * @param id - Delivery row identifier.
 * @param error - Bounded error detail to persist.
 * @param retryable - Whether the delivery may be retried.
 * @param claimToken - Token proving current lease ownership.
 * @returns An Effect that completes after the guarded update.
 */
export const updateDeliveryFailure = (
  env: WorkerEnv,
  id: string,
  error: string,
  retryable: boolean,
  claimToken: string
) =>
  d1(() =>
    env.DB.prepare(
      "UPDATE deliveries SET status = ?, attempts = attempts + 1, last_error = ?, claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'sent' AND claim_token = ?"
    )
      .bind(
        retryable ? "queued" : "failed",
        error.slice(0, 500),
        id,
        claimToken
      )
      .run()
  ).pipe(Effect.asVoid);

/**
 * Mark an unowned or expired delivery as failed after queue retries are spent.
 * @param env - Worker bindings containing the D1 database.
 * @param id - Durable delivery row identifier.
 * @returns Whether the guarded update changed a delivery row.
 */
export const markDeadLetter = (env: WorkerEnv, id: string) =>
  d1(() =>
    env.DB.prepare(
      "UPDATE deliveries SET status = 'failed', last_error = 'queue_retry_exhausted', claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'sent' AND (claim_token IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)"
    )
      .bind(id)
      .run()
  ).pipe(Effect.map((result) => result.meta.changes > 0));

/**
 * Atomically claim a queued delivery or report its current ownership state.
 * The two-minute lease exceeds Resend's timeout; expired leases can be reclaimed.
 * @param env - Worker bindings containing the D1 database.
 * @param id - Durable delivery row identifier.
 * @param announcementId - Announcement row associated with the delivery.
 * @param claimToken - Token to assign as the lease owner.
 * @returns `claimed`, `in_flight`, or `complete` according to current state.
 */
export const claimDelivery = (
  env: WorkerEnv,
  id: string,
  announcementId: string,
  claimToken: string
) =>
  Effect.gen(function* claimDeliveryEffect() {
    const claimed = yield* d1(() =>
      env.DB.prepare(
        "UPDATE deliveries SET claim_token = ?, claim_expires_at = datetime('now', '+2 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND announcement_id = ? AND status IN ('pending', 'queued') AND (claim_token IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP) RETURNING id"
      )
        .bind(claimToken, id, announcementId)
        .first<ClaimRow>()
    );
    if (claimed) return "claimed" as const;
    const activeClaim = yield* d1(() =>
      env.DB.prepare(
        "SELECT id FROM deliveries WHERE id = ? AND announcement_id = ? AND status IN ('pending', 'queued') AND claim_token IS NOT NULL AND claim_expires_at > CURRENT_TIMESTAMP"
      )
        .bind(id, announcementId)
        .first<ClaimRow>()
    );
    return activeClaim ? ("in_flight" as const) : ("complete" as const);
  });

/** Minimal D1 row returned by atomic claim statements. */
interface ClaimRow {
  readonly id: string;
}
