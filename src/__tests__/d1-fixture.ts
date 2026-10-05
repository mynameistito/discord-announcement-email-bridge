import {
  activeClaimSql,
  claimSql,
  d1Result,
  deadLetterSql,
  hasActiveClaim,
  isClaimable,
  pendingDeliveriesSql,
  pendingRows,
  projectRow,
  recoverExpiredSql,
} from "@/__tests__/d1-test-support";
import type {
  D1Fixture,
  FakeAnnouncement,
  FakeDelivery,
  FakeSubscription,
} from "@/__tests__/d1-test-support";
import type { WorkerEnv } from "@/alchemy.run";

/**
 * Create seeded delivery state and D1 bindings that recognize production SQL.
 * @returns A complete worker environment and its mutable seeded delivery state.
 */
export const makeD1Fixture = (): D1Fixture => {
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
      generation: "initial",
      id: "old-delivery",
      status: "queued",
    },
    {
      announcementId: "claim-announcement",
      claimToken: null,
      createdAt: 2,
      expired: false,
      generation: "initial",
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
            const [token, id, announcementId, generation] = values;
            if (
              token === undefined ||
              id === undefined ||
              announcementId === undefined ||
              generation === undefined
            ) {
              throw new Error("Missing expected delivery claim bindings");
            }
            const delivery = deliveries.find((row) =>
              isClaimable(row, id, announcementId, generation)
            );
            if (!delivery) {
              return Promise.resolve(null);
            }
            delivery.claimToken = token;
            delivery.expired = false;
            return Promise.resolve(projectRow<T>({ id: delivery.id }));
          }
          if (query === activeClaimSql) {
            const [id, announcementId, generation] = values;
            const delivery = deliveries.find((row) =>
              hasActiveClaim(row, id, announcementId, generation)
            );
            return Promise.resolve(
              delivery ? projectRow<T>({ id: delivery.id }) : null
            );
          }
          throw new Error(`Unexpected D1 query: ${query}`);
        },
        run(): Promise<D1Result> {
          if (query === deadLetterSql) {
            const [id, generation] = values;
            const delivery = deliveries.find(
              (row) =>
                row.id === id &&
                row.generation === generation &&
                row.status === "queued" &&
                row.expired
            );
            if (!delivery) {
              return Promise.resolve(d1Result([], 0));
            }
            delivery.status = "failed";
            delivery.claimToken = null;
            return Promise.resolve(d1Result([], 1));
          }
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
