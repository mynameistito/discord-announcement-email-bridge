import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  BridgeInfrastructureError,
  DiscordApiError,
  pollAll,
  pollingServiceLayer,
} from "../application";
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
  readonly beforeValues: () => readonly string[];
}

function fakePorts(
  pages: readonly (readonly unknown[])[],
  initialCursor: string | null = "100",
  failEnqueueCount = 0
): FakePollingPorts {
  let cursorValue: string | undefined = initialCursor ?? undefined;
  let initialized = initialCursor !== null;
  const discovered = new Map<string, string>();
  const queued: string[] = [];
  const marked = new Set<string>();
  const beforeValues: string[] = [];
  let beforeIndex = 0;
  let enqueueAttempts = 0;
  const ports: PollingPorts = {
    enqueue: (delivery) =>
      Effect.suspend(() => {
        enqueueAttempts += 1;
        if (enqueueAttempts <= failEnqueueCount) {
          return Effect.fail(
            new BridgeInfrastructureError("queue_send", "test failure", true)
          );
        }
        return Effect.sync(() => {
          queued.push(delivery.deliveryId);
        });
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
      fetchBefore: (_channelId, before) => {
        beforeIndex += 1;
        beforeValues.push(before);
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
    beforeValues: () => beforeValues,
  };
}

describe("announcement discovery integration", () => {
  it("paginates beyond 100, sorts safely, and advances only after durable persistence", async () => {
    const newestPage = Array.from({ length: 100 }, (_, index) =>
      crosspost(String(200 - index))
    );
    const olderPage = Array.from({ length: 100 }, (_, index) =>
      crosspost(String(100 - index))
    );
    const fake = fakePorts([newestPage, olderPage], "0");
    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(fake.ports)))
    );
    expect(fake.cursor()).toBe("200");
    expect(fake.sent()).toHaveLength(200);
    expect(fake.beforeValues()).toStrictEqual(["101", "1"]);
    expect(fake.sent()[0]).toBe("delivery-1");
    expect(fake.sent().at(-1)).toBe("delivery-200");
  });

  it("re-enqueues a persisted pending delivery after enqueue fails", async () => {
    const fake = fakePorts([[crosspost("101")]], "100", 1);
    await expect(
      Effect.runPromise(
        pollAll.pipe(Effect.provide(pollingServiceLayer(fake.ports)))
      )
    ).rejects.toThrow("queue_send");
    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(fake.ports)))
    );
    expect(fake.sent()).toStrictEqual(["delivery-101"]);
  });

  it("does not advance past a malformed possible crosspost", async () => {
    const malformed = { ...crosspost("101"), content: 1 };
    const fake = fakePorts([[malformed]]);
    await expect(
      Effect.runPromise(
        pollAll.pipe(Effect.provide(pollingServiceLayer(fake.ports)))
      )
    ).rejects.toThrow("malformed crosspost candidate");
    expect(fake.cursor()).toBe("100");
  });

  it("continues polling other subscriptions after one subscription fails", async () => {
    const other: Subscription = {
      ...subscription,
      destinationChannelId: "other-channel",
      id: "other-subscription",
    };
    const fake = fakePorts([]);
    const persisted: string[] = [];
    const ports: PollingPorts = {
      ...fake.ports,
      repository: {
        ...fake.ports.repository,
        cursor: () => Effect.succeed("100"),
        enabledSubscriptions: () => Effect.succeed([subscription, other]),
        persistDiscoveryBatch: (current) =>
          Effect.sync(() => persisted.push(current.id)),
      },
      source: {
        ...fake.ports.source,
        fetchAfter: (channelId) =>
          channelId === subscription.destinationChannelId
            ? Effect.fail(new DiscordApiError("temporary failure", 503, true))
            : Effect.succeed([
                {
                  raw: {
                    ...crosspost("101"),
                    channel_id: other.destinationChannelId,
                  },
                },
              ]),
      },
    };
    await expect(
      Effect.runPromise(
        pollAll.pipe(Effect.provide(pollingServiceLayer(ports)))
      )
    ).rejects.toThrow("Polling failed");
    expect(persisted).toStrictEqual([other.id]);
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

  it("initializes from the latest existing message without emailing history", async () => {
    const fake = fakePorts([[crosspost("200"), crosspost("201")]], null);
    const ports: PollingPorts = {
      ...fake.ports,
      source: {
        ...fake.ports.source,
        fetchLatest: () => Effect.succeed([{ raw: crosspost("200") }]),
      },
    };
    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(ports)))
    );
    expect(fake.cursor()).toBe("200");
    expect(fake.sent()).toStrictEqual([]);

    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(ports)))
    );
    expect(fake.sent()).toStrictEqual(["delivery-201"]);
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
