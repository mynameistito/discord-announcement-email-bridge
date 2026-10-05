import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import {
  crosspost,
  fakePorts,
  subscription,
} from "@/__tests__/application-fixtures";
import { pollAll, pollingServiceLayer } from "@/application/polling";
import type { PollingPorts } from "@/application/polling";
import { DiscordApiError } from "@/discord-api-error";
import type { Subscription } from "@/domain";

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

  it("logs and skips contentless crossposts while delivering later messages", async () => {
    const contentless = {
      ...crosspost("101"),
      attachments: [],
      content: "",
      embeds: [],
    };
    const fake = fakePorts([[contentless, crosspost("102")]]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await Effect.runPromise(
        pollAll.pipe(Effect.provide(pollingServiceLayer(fake.ports)))
      );
      expect(fake.cursor()).toBe("102");
      expect(fake.sent()).toStrictEqual(["delivery-102"]);
      expect(warning).toHaveBeenCalledWith(
        JSON.stringify({
          event: "announcement.content_unavailable",
          messageId: "101",
          subscriptionId: subscription.id,
        })
      );
    } finally {
      warning.mockRestore();
    }
  });

  it("ignores malformed crossposts at or below the saved cursor", async () => {
    const newestPage = Array.from({ length: 100 }, (_, index) =>
      crosspost(String(200 - index))
    );
    const malformedOldMessage = { ...crosspost("99"), content: 1 };
    const fake = fakePorts([newestPage, [malformedOldMessage]]);
    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(fake.ports)))
    );
    expect(fake.cursor()).toBe("200");
    expect(fake.sent()).toHaveLength(100);
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
});
