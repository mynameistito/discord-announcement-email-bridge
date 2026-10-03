import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { DiscordApiError, pollAll, pollingServiceLayer } from "../application";
import type { PollingPorts } from "../application";
import type { Subscription } from "../domain";

const subscription: Subscription = {
  destinationChannelId: "target-channel",
  destinationGuildId: "target-guild",
  emailTo: "recipient@example.test",
  id: "sub",
};

function crosspost(id: string) {
  return {
    attachments: [],
    author: { username: "news" },
    channel_id: "target-channel",
    content: `Announcement ${id}`,
    embeds: [],
    flags: 2,
    id,
    message_reference: {
      channel_id: "source-channel",
      guild_id: "source-guild",
      message_id: id,
    },
    timestamp: "2026-10-03T10:00:00Z",
    type: 0,
    webhook_id: "follower",
  };
}

interface FakePollingPorts {
  readonly ports: PollingPorts;
  readonly cursor: () => string | undefined;
  readonly sent: () => readonly string[];
}

function fakePorts(
  pages: readonly (readonly unknown[])[],
  initialCursor: string | null = "100"
): FakePollingPorts {
  let cursorValue: string | undefined = initialCursor ?? undefined;
  let initialized = initialCursor !== null;
  const discovered = new Map<string, string>();
  const queued: string[] = [];
  const marked = new Set<string>();
  let beforeIndex = 0;
  const ports: PollingPorts = {
    enqueue: (delivery) =>
      Effect.sync(() => {
        queued.push(delivery.deliveryId);
      }),
    repository: {
      cursor: () =>
        Effect.succeed(initialized ? (cursorValue ?? "0") : undefined),
      enabledSubscriptions: () => Effect.succeed([subscription]),
      initializeCursor: (_id, messageId) =>
        Effect.sync(() => {
          cursorValue = messageId;
          initialized = true;
        }),
      markEnqueued: (id) =>
        Effect.sync(() => {
          marked.add(id.replace("delivery-", ""));
        }),
      pendingDeliveries: () =>
        Effect.succeed(
          [...discovered.values()]
            .filter((id) => !marked.has(id))
            .map((id) => ({
              deliveryId: `delivery-${id}`,
              announcementId: `announcement-${id}`,
            }))
        ),
      persistDiscoveryBatch: (_subscription, announcements, cursor) =>
        Effect.sync(() => {
          for (const item of announcements) {
            discovered.set(item.message.id, item.message.id);
          }
          cursorValue = cursor;
        }),
    },
    source: {
      fetchAfter: () =>
        Effect.succeed((pages[0] ?? []).map((raw) => ({ raw }))),
      fetchBefore: () => {
        beforeIndex += 1;
        return Effect.succeed(
          (pages[beforeIndex] ?? []).map((raw) => ({ raw }))
        );
      },
      fetchLatest: () => Effect.succeed([]),
      getWebhook: (id) =>
        Effect.succeed({
          id,
          type: 2,
          source_guild: { id: "source-guild" },
          source_channel: { id: "source-channel" },
        }),
    },
  };
  return {
    cursor: () => (initialized ? (cursorValue ?? "0") : undefined),
    ports,
    sent: () => queued,
  };
}

describe("announcement discovery integration", () => {
  it("paginates beyond 100, sorts safely, and advances only after durable persistence", async () => {
    const newestPage = Array.from({ length: 100 }, (_, index) =>
      crosspost(String(200 - index))
    );
    const olderPage = [crosspost("101")];
    const fake = fakePorts([newestPage, olderPage]);
    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(fake.ports)))
    );
    expect(fake.cursor()).toBe("200");
    expect(fake.sent()).toHaveLength(100);
    expect(fake.sent()[0]).toBe("delivery-101");
    expect(fake.sent().at(-1)).toBe("delivery-200");
  });

  it("keeps repeats safe: the persistent uniqueness seam yields one logical delivery", async () => {
    const fake = fakePorts([[crosspost("101")]]);
    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(fake.ports)))
    );
    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(fake.ports)))
    );
    expect(fake.sent()).toStrictEqual(["delivery-101"]);
  });

  it("does not skip the first message after initializing an empty channel", async () => {
    const fake = fakePorts([[crosspost("101")]], null);
    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(fake.ports)))
    );
    expect(fake.cursor()).toBe("0");
    expect(fake.sent()).toStrictEqual([]);

    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(fake.ports)))
    );
    expect(fake.sent()).toStrictEqual(["delivery-101"]);
  });

  it("does not advance the cursor if a later page fails", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      crosspost(String(200 - index))
    );
    const fake = fakePorts([firstPage]);
    const ports: PollingPorts = {
      ...fake.ports,
      source: {
        ...fake.ports.source,
        fetchBefore: () =>
          Effect.fail(new DiscordApiError("network error", 503, true)),
      },
    };
    await expect(
      Effect.runPromise(
        pollAll.pipe(Effect.provide(pollingServiceLayer(ports)))
      )
    ).rejects.toThrow("network error");
    expect(fake.cursor()).toBe("100");
    expect(fake.sent()).toStrictEqual([]);
  });
});
