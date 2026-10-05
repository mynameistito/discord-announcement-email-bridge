import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { crosspost, fakePorts } from "@/__tests__/application-fixtures";
import { pollAll, pollingServiceLayer } from "@/application/polling";
import type { PollingPorts } from "@/application/polling";
import { DiscordApiError } from "@/discord-api-error";

describe("announcement source metadata", () => {
  it("delivers announcements when optional metadata is unavailable", async () => {
    const fake = fakePorts([[crosspost("101")]]);
    const ports: PollingPorts = {
      ...fake.ports,
      source: {
        ...fake.ports.source,
        getSourceMetadata: () =>
          Effect.fail(
            new DiscordApiError("metadata access denied", 403, false)
          ),
      },
    };

    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(ports)))
    );
    expect(fake.sent()).toStrictEqual(["delivery-101"]);
  });

  it("deduplicates fallback metadata lookups per source in a poll", async () => {
    const fake = fakePorts([[crosspost("101"), crosspost("102")]]);
    let lookups = 0;
    const ports: PollingPorts = {
      ...fake.ports,
      source: {
        ...fake.ports.source,
        getSourceMetadata: () =>
          Effect.sync(() => {
            lookups += 1;
            return { channelName: "announcements", guildName: "News server" };
          }),
      },
    };

    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(ports)))
    );
    expect([lookups, fake.sent().length]).toStrictEqual([1, 2]);
  });

  it("uses source metadata embedded in the follower webhook", async () => {
    const fake = fakePorts([[crosspost("101")]]);
    let fallbackLookups = 0;
    const ports: PollingPorts = {
      ...fake.ports,
      source: {
        ...fake.ports.source,
        getSourceMetadata: () =>
          Effect.sync(() => {
            fallbackLookups += 1;
            return { channelName: "fallback", guildName: "fallback" };
          }),
        getWebhook: (id) =>
          Effect.succeed({
            id,
            source_channel: { id: "source-channel", name: "announcements" },
            source_guild: {
              icon: "guild-icon",
              id: "source-guild",
              name: "News server",
            },
            type: 2,
          }),
      },
    };

    await Effect.runPromise(
      pollAll.pipe(Effect.provide(pollingServiceLayer(ports)))
    );
    const [announcement] = fake.discoveries();

    expect([fallbackLookups, announcement?.sourceMetadata]).toStrictEqual([
      0,
      {
        channelName: "announcements",
        guildIconUrl:
          "https://cdn.discordapp.com/icons/source-guild/guild-icon.png?size=128",
        guildName: "News server",
      },
    ]);
  });
});
