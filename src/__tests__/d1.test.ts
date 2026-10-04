import { Database } from "bun:sqlite";

import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeRepository } from "@/adapters/d1";
import type { WorkerEnv } from "@/alchemy.run";

const database = new Database(":memory:");
database.exec(`
  CREATE TABLE announcements (
    id TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL
  );
  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    announcement_id TEXT NOT NULL,
    status TEXT NOT NULL,
    claim_token TEXT,
    claim_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

/**
 * Map a SQLite row to the generic row type requested by the D1 query caller.
 * @param row - Result row produced by the prepared SQLite query.
 * @returns The row expressed as the D1 caller's requested projection type.
 */
const toD1Row = <T>(
  row: Record<string, string | number | bigint | boolean | null | Uint8Array>
): T =>
  // SAFETY: The test SQL projection determines the row shape requested by the D1 caller.
  ({ ...row }) as T;

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

const d1DatabaseBindings = {
  prepare(query: string) {
    const statement = database.query(query);
    let values: Parameters<typeof statement.run> = [];
    const prepared = {
      all<T>(): Promise<D1Result<T>> {
        const results = statement.all(...values).map(toD1Row<T>);
        return Promise.resolve(d1Result(results));
      },
      bind(...bindings: Parameters<typeof statement.run>) {
        values = bindings;
        return prepared;
      },
      first<T>(): Promise<T | null> {
        const row = statement.get(...values);
        return Promise.resolve(row ? toD1Row<T>(row) : null);
      },
      run(): Promise<D1Result> {
        const result = statement.run(...values);
        return Promise.resolve(d1Result([], result.changes));
      },
    };
    return prepared;
  },
};
// SAFETY: The repository paths exercised here use only the implemented `prepare` binding.
const d1Database = d1DatabaseBindings as WorkerEnv["DB"];

const env: WorkerEnv = {
  ADMIN_TOKEN: "test-admin-token",
  BUILD_VERSION: "test-build",
  DB: d1Database,
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
const repository = makeRepository(env);

describe("D1 polling repository", () => {
  beforeEach(() => {
    database.exec(`
      INSERT INTO announcements (id, subscription_id)
        VALUES ('old-announcement', 'disabled-subscription');
      INSERT INTO deliveries (
        id, announcement_id, status, claim_token, claim_expires_at
      ) VALUES (
        'old-delivery', 'old-announcement', 'queued', 'expired-token',
        datetime('now', '-1 minute')
      );
    `);
  });

  afterEach(() => {
    database.exec("DELETE FROM deliveries; DELETE FROM announcements;");
  });

  it("recovers expired deliveries from disabled subscriptions", async () => {
    const pending = await Effect.runPromise(repository.pendingDeliveries());

    expect(pending).toStrictEqual([
      {
        announcementId: "old-announcement",
        deliveryId: "old-delivery",
      },
    ]);
    expect(
      database
        .query(
          "SELECT status, claim_token FROM deliveries WHERE id = 'old-delivery'"
        )
        .get()
    ).toStrictEqual({ claim_token: null, status: "pending" });
  });
});
