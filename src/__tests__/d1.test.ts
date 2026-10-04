import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claimDelivery, makeRepository } from "@/adapters/d1";
import type { WorkerEnv } from "@/alchemy.run";

const recoverExpiredSql =
  "UPDATE deliveries SET status = 'pending', claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'queued' AND claim_token IS NOT NULL AND claim_expires_at <= CURRENT_TIMESTAMP";
const pendingDeliveriesSql =
  "SELECT d.id AS delivery_id, d.announcement_id FROM deliveries d JOIN announcements a ON a.id = d.announcement_id WHERE d.status = 'pending' ORDER BY d.created_at LIMIT 500";
const claimSql =
  "UPDATE deliveries SET claim_token = ?, claim_expires_at = datetime('now', '+2 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND announcement_id = ? AND status IN ('pending', 'queued') AND (claim_token IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP) RETURNING id";
const activeClaimSql =
  "SELECT id FROM deliveries WHERE id = ? AND announcement_id = ? AND status IN ('pending', 'queued') AND claim_token IS NOT NULL AND claim_expires_at > CURRENT_TIMESTAMP";

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
 * @returns Whether the candidate satisfies the statement's predicates.
 */
const isClaimable = (
  row: FakeDelivery,
  id: string | undefined,
  announcementId: string | undefined
): boolean =>
  row.id === id &&
  row.announcementId === announcementId &&
  hasClaimableStatus(row) &&
  hasNoLiveLease(row);

/**
 * Match a delivery against the production live-claim statement's conditions.
 * @param row - Candidate delivery row.
 * @param id - Delivery ID bound to the live-claim statement.
 * @param announcementId - Announcement ID bound to the live-claim statement.
 * @returns Whether the candidate satisfies the statement's predicates.
 */
const hasActiveClaim = (
  row: FakeDelivery,
  id: string | undefined,
  announcementId: string | undefined
): boolean =>
  row.id === id &&
  row.announcementId === announcementId &&
  row.claimToken !== null &&
  !row.expired;

/** Mutable delivery row state for the focused D1 SQL test double. */
interface FakeDelivery {
  readonly id: string;
  readonly announcementId: string;
  readonly createdAt: number;
  claimToken: string | null;
  expired: boolean;
  status: "pending" | "queued";
}

/** Subscription state used to verify recovery is not restricted to enabled rows. */
interface FakeSubscription {
  readonly enabled: boolean;
  readonly id: string;
}

/** Announcement rows joined by the production pending-deliveries query. */
interface FakeAnnouncement {
  readonly id: string;
  readonly subscriptionId: string;
}

/** Test-only bindings for exercising the real D1 adapter entry points. */
interface D1Fixture {
  readonly announcements: FakeAnnouncement[];
  readonly env: WorkerEnv;
  readonly deliveries: FakeDelivery[];
  readonly subscriptions: FakeSubscription[];
}

/**
 * Build a typed D1 result from the supplied query projection.
 * @param results - Rows matching the requested projection.
 * @param changes - Number of database rows changed by the statement.
 * @returns A successful D1 result containing the rows and change count.
 */
const d1Result = <T>(results: T[], changes = 0): D1Result<T> => ({
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
const projectRow = <T>(row: Record<string, string | null>): T =>
  // SAFETY: The exact SQL under test determines the projection returned by this fixture.
  ({ ...row }) as T;

/**
 * Execute the pending-query projection against fixture records.
 * @param deliveries - Candidate delivery rows.
 * @param announcements - Announcement rows used by the SQL inner join.
 * @returns Pending delivery projections ordered and capped as the SQL specifies.
 */
const pendingRows = <T>(
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
    .map(({ announcementId, id }) =>
      projectRow<T>({
        announcement_id: announcementId,
        delivery_id: id,
      })
    );

/**
 * Create seeded delivery state and D1 bindings that recognize production SQL.
 * @returns A complete worker environment and its mutable seeded delivery state.
 */
const makeD1Fixture = (): D1Fixture => {
  const subscriptions: FakeSubscription[] = [
    { enabled: false, id: "disabled-subscription" },
    { enabled: true, id: "active-subscription" },
  ];
  const announcements: FakeAnnouncement[] = [
    { id: "old-announcement", subscriptionId: "disabled-subscription" },
    { id: "claim-announcement", subscriptionId: "active-subscription" },
  ];
  const deliveries: FakeDelivery[] = [
    {
      announcementId: "old-announcement",
      claimToken: "expired-token",
      createdAt: 1,
      expired: true,
      id: "old-delivery",
      status: "queued",
    },
    {
      announcementId: "claim-announcement",
      claimToken: null,
      createdAt: 2,
      expired: false,
      id: "claim-delivery",
      status: "queued",
    },
  ];

  const bindings = {
    prepare(query: string) {
      let values: string[] = [];
      const statement = {
        all<T>(): Promise<D1Result<T>> {
          if (query !== pendingDeliveriesSql) {
            throw new Error(`Unexpected D1 query: ${query}`);
          }
          const results = pendingRows<T>(deliveries, announcements);
          return Promise.resolve(d1Result(results));
        },
        bind(...parameters: string[]) {
          values = parameters;
          return statement;
        },
        first<T>(): Promise<T | null> {
          if (query === claimSql) {
            const [token, id, announcementId] = values;
            if (
              token === undefined ||
              id === undefined ||
              announcementId === undefined
            ) {
              throw new Error("Missing expected delivery claim bindings");
            }
            const delivery = deliveries.find((row) =>
              isClaimable(row, id, announcementId)
            );
            if (!delivery) {
              return Promise.resolve(null);
            }
            delivery.claimToken = token;
            delivery.expired = false;
            return Promise.resolve(projectRow<T>({ id: delivery.id }));
          }
          if (query === activeClaimSql) {
            const [id, announcementId] = values;
            const delivery = deliveries.find((row) =>
              hasActiveClaim(row, id, announcementId)
            );
            return Promise.resolve(
              delivery ? projectRow<T>({ id: delivery.id }) : null
            );
          }
          throw new Error(`Unexpected D1 query: ${query}`);
        },
        run(): Promise<D1Result> {
          if (query !== recoverExpiredSql) {
            throw new Error(`Unexpected D1 query: ${query}`);
          }
          let changes = 0;
          for (const delivery of deliveries) {
            if (
              delivery.status === "queued" &&
              delivery.claimToken !== null &&
              delivery.expired
            ) {
              delivery.status = "pending";
              delivery.claimToken = null;
              changes += 1;
            }
          }
          return Promise.resolve(d1Result([], changes));
        },
      };
      return statement;
    },
  };
  // SAFETY: These tests call only D1 `prepare` methods, modeled above using the production SQL.
  const DB = bindings as WorkerEnv["DB"];
  const env: WorkerEnv = {
    ADMIN_TOKEN: "test-admin-token",
    BUILD_VERSION: "test-build",
    DB,
    DELIVERY_DEAD_LETTER_QUEUE_NAME: "dead-letter",
    DELIVERY_QUEUE: {
      metrics: () => Promise.resolve({ backlogBytes: 0, backlogCount: 0 }),
      send: () =>
        Promise.resolve({
          metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
        }),
      sendBatch: () =>
        Promise.resolve({
          metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
        }),
    },
    DISCORD_BOT_TOKEN: "test-discord-token",
    DISCORD_GUILD_ID: "test-guild",
    DISCORD_TARGET_CHANNEL_ID: "test-channel",
    EMAIL_FROM_EMAIL: "test@example.test",
    EMAIL_FROM_NAME: "Test",
    EMAIL_TO: "recipient@example.test",
    RESEND_API_KEY: "test-resend-key",
    SOURCE_CHANNEL_ID: "",
    SOURCE_GUILD_ID: "",
    STAGE: "test",
  };

  return { announcements, deliveries, env, subscriptions };
};

describe("D1 delivery repository", () => {
  let fixture: D1Fixture;

  beforeEach(() => {
    fixture = makeD1Fixture();
  });

  afterEach(() => {
    fixture.announcements.length = 0;
    fixture.deliveries.length = 0;
    fixture.subscriptions.length = 0;
  });

  it("recovers expired deliveries from disabled subscriptions", async () => {
    expect(fixture.subscriptions).toContainEqual({
      enabled: false,
      id: "disabled-subscription",
    });
    expect(fixture.announcements).toContainEqual({
      id: "old-announcement",
      subscriptionId: "disabled-subscription",
    });
    const pending = await Effect.runPromise(
      makeRepository(fixture.env).pendingDeliveries()
    );

    expect(pending).toStrictEqual([
      {
        announcementId: "old-announcement",
        deliveryId: "old-delivery",
      },
    ]);
    expect(fixture.deliveries[0]).toMatchObject({
      claimToken: null,
      status: "pending",
    });
  });

  it("joins announcements and returns the oldest 500 pending deliveries", async () => {
    fixture.announcements.length = 0;
    fixture.deliveries.length = 0;
    for (let index = 0; index < 501; index += 1) {
      const id = `announcement-${String(index).padStart(3, "0")}`;
      fixture.announcements.push({ id, subscriptionId: "active-subscription" });
      fixture.deliveries.push({
        announcementId: id,
        claimToken: null,
        createdAt: index,
        expired: false,
        id: `delivery-${String(index).padStart(3, "0")}`,
        status: "pending",
      });
    }
    fixture.deliveries.push({
      announcementId: "missing-announcement",
      claimToken: null,
      createdAt: -1,
      expired: false,
      id: "orphaned-delivery",
      status: "pending",
    });

    const pending = await Effect.runPromise(
      makeRepository(fixture.env).pendingDeliveries()
    );

    expect(pending).toHaveLength(500);
    expect(pending[0]).toStrictEqual({
      announcementId: "announcement-000",
      deliveryId: "delivery-000",
    });
    expect(pending.at(-1)).toStrictEqual({
      announcementId: "announcement-499",
      deliveryId: "delivery-499",
    });
  });

  it("claims queued deliveries, reports live leases, and reclaims expired leases", async () => {
    const firstClaim = await Effect.runPromise(
      claimDelivery(
        fixture.env,
        "claim-delivery",
        "claim-announcement",
        "first-token"
      )
    );
    const competingClaim = await Effect.runPromise(
      claimDelivery(
        fixture.env,
        "claim-delivery",
        "claim-announcement",
        "competing-token"
      )
    );
    const [, claimedDelivery] = fixture.deliveries;
    if (!claimedDelivery) {
      throw new Error("Expected seeded claim delivery");
    }
    claimedDelivery.expired = true;
    const recoveredClaim = await Effect.runPromise(
      claimDelivery(
        fixture.env,
        "claim-delivery",
        "claim-announcement",
        "recovery-token"
      )
    );

    expect([firstClaim, competingClaim, recoveredClaim]).toStrictEqual([
      "claimed",
      "in_flight",
      "claimed",
    ]);
  });
});
