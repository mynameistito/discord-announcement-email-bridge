import { makeD1Fixture } from "@tests/d1-fixture";
import type { D1Fixture } from "@tests/d1-fixture";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeRepository, pendingDeliveriesSql } from "@/adapters/d1";
import { claimDelivery, markDeadLetter } from "@/adapters/d1-deliveries";

describe("D1 delivery repository", () => {
  let fixture: D1Fixture;

  beforeEach(async () => {
    fixture = await makeD1Fixture();
    const db = fixture.env.DB;

    await db
      .prepare(
        "INSERT INTO subscriptions (id, destination_guild_id, destination_channel_id, email_to, enabled) VALUES ('disabled', 'g', 'd', 'a@example.test', 0), ('active', 'g', 'a', 'a@example.test', 1)"
      )
      .run();
    await db
      .prepare(
        "INSERT INTO announcements (id, subscription_id, discord_message_id, source_guild_id, source_channel_id, source_message_id, follower_webhook_id, normalized_payload, message_created_at) VALUES ('old-announcement', 'disabled', '1', 'g', 'c', '1', 'w', '{}', '2026-01-01'), ('claim-announcement', 'active', '2', 'g', 'c', '2', 'w', '{}', '2026-01-01')"
      )
      .run();
    await db
      .prepare(
        "INSERT INTO deliveries (id, announcement_id, recipient, status, idempotency_key, claim_token, claim_expires_at, created_at) VALUES ('old-delivery', 'old-announcement', 'a@example.test', 'queued', 'old-key', 'expired-token', '2000-01-01', '2026-01-01'), ('claim-delivery', 'claim-announcement', 'a@example.test', 'queued', 'claim-key', NULL, NULL, '2026-01-02')"
      )
      .run();
  });

  afterEach(async () => {
    await fixture.dispose();
  });

  it("recovers expired deliveries from disabled subscriptions", async () => {
    const pending = await Effect.runPromise(
      makeRepository(fixture.env).pendingDeliveries()
    );

    expect(pending).toStrictEqual([
      {
        announcementId: "old-announcement",
        deliveryId: "old-delivery",
        generation: "initial",
      },
    ]);
    await expect(
      fixture.env.DB.prepare(
        "SELECT status, claim_token FROM deliveries WHERE id = 'old-delivery'"
      ).first()
    ).resolves.toMatchObject({ claim_token: null, status: "pending" });
  });

  it("rejects deliveries that reference a missing announcement", async () => {
    await expect(
      fixture.env.DB.prepare(
        "INSERT INTO deliveries (id, announcement_id, recipient, status, idempotency_key) VALUES ('orphan', 'missing', 'a@example.test', 'pending', 'orphan-key')"
      ).run()
    ).rejects.toThrow("FOREIGN KEY constraint failed");
  });

  it("excludes an existing orphan from the pending-deliveries join", async () => {
    const db = fixture.env.DB;

    await db
      .prepare(
        "UPDATE deliveries SET status = 'pending' WHERE id = 'old-delivery'"
      )
      .run();

    // Defer the constraint only inside this transaction, then remove the
    // orphan before commit so the real D1 database retains its FK invariant.
    const results = await db.batch([
      db.prepare("PRAGMA defer_foreign_keys = ON"),
      db.prepare(
        "INSERT INTO deliveries (id, announcement_id, recipient, status, idempotency_key) VALUES ('orphan', 'missing', 'a@example.test', 'pending', 'orphan-key')"
      ),
      db.prepare(
        "SELECT COUNT(*) AS count FROM deliveries WHERE id = 'orphan'"
      ),
      db.prepare(pendingDeliveriesSql),
      db.prepare("DELETE FROM deliveries WHERE id = 'orphan'"),
    ]);

    expect(results[2]?.results).toStrictEqual([{ count: 1 }]);
    expect(results[3]?.results).toStrictEqual([
      {
        announcement_id: "old-announcement",
        delivery_id: "old-delivery",
        generation: "initial",
      },
    ]);
  });

  it("joins announcements and returns the oldest 500 pending deliveries", async () => {
    const db = fixture.env.DB;

    await db.prepare("DELETE FROM deliveries").run();
    await db.prepare("DELETE FROM announcements").run();

    await db
      .prepare(
        "WITH RECURSIVE ids(n) AS (VALUES (0) UNION ALL SELECT n + 1 FROM ids WHERE n < 500) INSERT INTO announcements (id, subscription_id, discord_message_id, source_guild_id, source_channel_id, source_message_id, follower_webhook_id, normalized_payload, message_created_at) SELECT printf('announcement-%03d', n), 'active', printf('%03d', n), 'g', 'c', '1', 'w', '{}', '2026-01-01' FROM ids"
      )
      .run();
    await db
      .prepare(
        "WITH RECURSIVE ids(n) AS (VALUES (0) UNION ALL SELECT n + 1 FROM ids WHERE n < 500) INSERT INTO deliveries (id, announcement_id, recipient, status, idempotency_key, created_at) SELECT printf('delivery-%03d', n), printf('announcement-%03d', n), 'a@example.test', 'pending', printf('key-%03d', n), datetime('2026-01-01', printf('+%d seconds', n)) FROM ids"
      )
      .run();

    const pending = await Effect.runPromise(
      makeRepository(fixture.env).pendingDeliveries()
    );

    expect(pending).toHaveLength(500);
    expect(pending[0]).toStrictEqual({
      announcementId: "announcement-000",
      deliveryId: "delivery-000",
      generation: "initial",
    });
    expect(pending.at(-1)).toStrictEqual({
      announcementId: "announcement-499",
      deliveryId: "delivery-499",
      generation: "initial",
    });
  });

  it("claims queued deliveries, reports live leases, and reclaims expired leases", async () => {
    const claim = async (token: string) =>
      await Effect.runPromise(
        claimDelivery(
          fixture.env,
          "claim-delivery",
          "claim-announcement",
          token,
          "initial"
        )
      );

    const first = await claim("first-token");
    const competing = await claim("competing-token");

    await fixture.env.DB.prepare(
      "UPDATE deliveries SET claim_expires_at = '2000-01-01' WHERE id = 'claim-delivery'"
    ).run();
    const recovered = await claim("recovery-token");

    expect([first, competing, recovered]).toStrictEqual([
      "claimed",
      "in_flight",
      "claimed",
    ]);
  });

  it("does not let a stale dead-letter message fail a replayed delivery", async () => {
    const mark = async (generation: string) =>
      await Effect.runPromise(
        markDeadLetter(fixture.env, "old-delivery", generation)
      );

    const marked = await mark("initial");

    await fixture.env.DB.prepare(
      "UPDATE deliveries SET status = 'pending', generation = 'replay-generation' WHERE id = 'old-delivery'"
    ).run();

    const staleClaim = await Effect.runPromise(
      claimDelivery(
        fixture.env,
        "old-delivery",
        "old-announcement",
        "old-queue-token",
        "initial"
      )
    );

    const staleMark = await mark("initial");

    await fixture.env.DB.prepare(
      "UPDATE deliveries SET status = 'queued' WHERE id = 'old-delivery'"
    ).run();
    const staleRetry = await mark("initial");
    const currentMark = await mark("replay-generation");

    const row = await fixture.env.DB.prepare(
      "SELECT status FROM deliveries WHERE id = 'old-delivery'"
    ).first();

    expect([
      marked,
      staleClaim,
      staleMark,
      staleRetry,
      currentMark,
      row,
    ]).toStrictEqual([
      true,
      "complete",
      false,
      false,
      true,
      { status: "failed" },
    ]);
  });

  it("dead-letters a queued delivery without an active claim token", async () => {
    await fixture.env.DB.prepare(
      "UPDATE deliveries SET claim_token = NULL, claim_expires_at = NULL WHERE id = 'old-delivery'"
    ).run();

    const marked = await Effect.runPromise(
      markDeadLetter(fixture.env, "old-delivery", "initial")
    );

    const row = await fixture.env.DB.prepare(
      "SELECT status FROM deliveries WHERE id = 'old-delivery'"
    ).first();

    expect([marked, row]).toStrictEqual([true, { status: "failed" }]);
  });
});
