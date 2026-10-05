import type { WorkerEnv } from "@/alchemy.run";

export const recoverExpiredSql =
  "UPDATE deliveries SET status = 'pending', claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'queued' AND claim_token IS NOT NULL AND claim_expires_at <= CURRENT_TIMESTAMP";
export const pendingDeliveriesSql =
  "SELECT d.id AS delivery_id, d.announcement_id, d.generation FROM deliveries d JOIN announcements a ON a.id = d.announcement_id WHERE d.status = 'pending' ORDER BY d.created_at LIMIT 500";
export const claimSql =
  "UPDATE deliveries SET claim_token = ?, claim_expires_at = datetime('now', '+2 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND announcement_id = ? AND generation = ? AND status IN ('pending', 'queued') AND (claim_token IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP) RETURNING id";
export const activeClaimSql =
  "SELECT id FROM deliveries WHERE id = ? AND announcement_id = ? AND generation = ? AND status IN ('pending', 'queued') AND claim_token IS NOT NULL AND claim_expires_at > CURRENT_TIMESTAMP";
export const deadLetterSql =
  "UPDATE deliveries SET status = 'failed', last_error = 'queue_retry_exhausted', claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND generation = ? AND status = 'queued' AND (claim_token IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)";

/** Mutable delivery row state for the focused D1 SQL test double. */
export interface FakeDelivery {
  readonly id: string;
  readonly announcementId: string;
  generation: string;
  readonly createdAt: number;
  claimToken: string | null;
  expired: boolean;
  status: "pending" | "queued" | "failed";
}

const matchesDeliveryIdentity = (
  row: FakeDelivery,
  id: string | undefined,
  announcementId: string | undefined,
  generation: string | undefined
): boolean =>
  row.id === id &&
  row.announcementId === announcementId &&
  row.generation === generation;

/** Subscription state used to verify recovery is not restricted to enabled rows. */
export interface FakeSubscription {
  readonly enabled: boolean;
  readonly id: string;
}

/** Announcement rows joined by the production pending-deliveries query. */
export interface FakeAnnouncement {
  readonly id: string;
  readonly subscriptionId: string;
}

/** Test-only bindings for exercising the real D1 adapter entry points. */
export interface D1Fixture {
  readonly announcements: FakeAnnouncement[];
  readonly env: WorkerEnv;
  readonly deliveries: FakeDelivery[];
  readonly subscriptions: FakeSubscription[];
}

/**
 * Check the statuses accepted by the production claim statement.
 * @param row - Candidate delivery row.
 * @returns Whether the status is eligible for a claim.
 */
const hasClaimableStatus = (row: FakeDelivery): boolean =>
  row.status === "pending" || row.status === "queued";

/**
 * Check whether the delivery has no lease or an expired lease.
 * @param row - Candidate delivery row.
 * @returns Whether the row can be claimed without a live lease.
 */
const hasNoLiveLease = (row: FakeDelivery): boolean =>
  row.claimToken === null || row.expired;

/**
 * Match a delivery against the production claim statement's eligibility conditions.
 * @param row - Candidate delivery row.
 * @param id - Delivery ID bound to the claim statement.
 * @param announcementId - Announcement ID bound to the claim statement.
 * @param generation - Queue generation bound to the claim statement.
 * @returns Whether the candidate satisfies the statement's predicates.
 */
export const isClaimable = (
  row: FakeDelivery,
  id: string | undefined,
  announcementId: string | undefined,
  generation: string | undefined
): boolean =>
  matchesDeliveryIdentity(row, id, announcementId, generation) &&
  hasClaimableStatus(row) &&
  hasNoLiveLease(row);

/**
 * Match a delivery against the production live-claim statement's conditions.
 * @param row - Candidate delivery row.
 * @param id - Delivery ID bound to the live-claim statement.
 * @param announcementId - Announcement ID bound to the live-claim statement.
 * @param generation - Queue generation bound to the live-claim statement.
 * @returns Whether the candidate satisfies the statement's predicates.
 */
export const hasActiveClaim = (
  row: FakeDelivery,
  id: string | undefined,
  announcementId: string | undefined,
  generation: string | undefined
): boolean =>
  matchesDeliveryIdentity(row, id, announcementId, generation) &&
  row.claimToken !== null &&
  !row.expired;

/**
 * Build a typed D1 result from the supplied query projection.
 * @param results - Rows matching the requested projection.
 * @param changes - Number of database rows changed by the statement.
 * @returns A successful D1 result containing the rows and change count.
 */
export const d1Result = <T>(results: T[], changes = 0): D1Result<T> => ({
  meta: {
    changed_db: changes > 0,
    changes,
    duration: 0,
    last_row_id: 0,
    rows_read: 0,
    rows_written: changes,
    size_after: 0,
  },
  results,
  success: true,
});

/**
 * Convert a known fake delivery projection to the query's requested row type.
 * @param row - The projection produced by the matched SQL statement.
 * @returns The projection typed for its D1 query caller.
 */
export const projectRow = <T>(row: Record<string, string | null>): T =>
  // SAFETY: The exact SQL under test determines the projection returned by this fixture.
  ({ ...row }) as T;

/**
 * Execute the pending-query projection against fixture records.
 * @param deliveries - Candidate delivery rows.
 * @param announcements - Announcement rows used by the SQL inner join.
 * @returns Pending delivery projections ordered and capped as the SQL specifies.
 */
export const pendingRows = <T>(
  deliveries: readonly FakeDelivery[],
  announcements: readonly FakeAnnouncement[]
): T[] =>
  deliveries
    .filter(({ status }) => status === "pending")
    .filter(({ announcementId }) =>
      announcements.some(({ id }) => id === announcementId)
    )
    .toSorted((left, right) => left.createdAt - right.createdAt)
    .slice(0, 500)
    .map(({ announcementId, generation, id }) =>
      projectRow<T>({
        announcement_id: announcementId,
        delivery_id: id,
        generation,
      })
    );
