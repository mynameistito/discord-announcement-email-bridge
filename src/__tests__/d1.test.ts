import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeD1Fixture } from "@/__tests__/d1-fixture";
import type { D1Fixture } from "@/__tests__/d1-test-support";
import { makeRepository } from "@/adapters/d1";
import { claimDelivery, markDeadLetter } from "@/adapters/d1-deliveries";

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
        generation: "initial",
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
        generation: "initial",
        id: `delivery-${String(index).padStart(3, "0")}`,
        status: "pending",
      });
    }
    fixture.deliveries.push({
      announcementId: "missing-announcement",
      claimToken: null,
      createdAt: -1,
      expired: false,
      generation: "initial",
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
      generation: "initial",
    });
    expect(pending.at(-1)).toStrictEqual({
      announcementId: "announcement-499",
      deliveryId: "delivery-499",
      generation: "initial",
    });
  });

  it("claims queued deliveries, reports live leases, and reclaims expired leases", async () => {
    const firstClaim = await Effect.runPromise(
      claimDelivery(
        fixture.env,
        "claim-delivery",
        "claim-announcement",
        "first-token",
        "initial"
      )
    );
    const competingClaim = await Effect.runPromise(
      claimDelivery(
        fixture.env,
        "claim-delivery",
        "claim-announcement",
        "competing-token",
        "initial"
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
        "recovery-token",
        "initial"
      )
    );

    expect([firstClaim, competingClaim, recoveredClaim]).toStrictEqual([
      "claimed",
      "in_flight",
      "claimed",
    ]);
  });

  it("does not let a stale dead-letter message fail a replayed delivery", async () => {
    const marked = await Effect.runPromise(
      markDeadLetter(fixture.env, "old-delivery", "initial")
    );
    const [delivery] = fixture.deliveries;
    if (!delivery) {
      throw new Error("Expected seeded dead-letter delivery");
    }
    delivery.status = "pending";
    delivery.generation = "replay-generation";
    const staleClaim = await Effect.runPromise(
      claimDelivery(
        fixture.env,
        "old-delivery",
        "old-announcement",
        "old-queue-token",
        "initial"
      )
    );
    const staleMark = await Effect.runPromise(
      markDeadLetter(fixture.env, "old-delivery", "initial")
    );
    delivery.status = "queued";
    const staleRetry = await Effect.runPromise(
      markDeadLetter(fixture.env, "old-delivery", "initial")
    );
    const currentMark = await Effect.runPromise(
      markDeadLetter(fixture.env, "old-delivery", "replay-generation")
    );

    expect([
      marked,
      staleClaim,
      staleMark,
      staleRetry,
      currentMark,
      delivery.status,
    ]).toStrictEqual([true, "complete", false, false, true, "failed"]);
  });
});
