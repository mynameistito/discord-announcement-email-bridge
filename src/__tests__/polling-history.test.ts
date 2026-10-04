import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { pollAll, pollingServiceLayer } from "@/application/polling";
import type { PollingPorts } from "@/application/polling";
import { DiscordApiError } from "@/discord-api-error";
import type { Subscription } from "@/domain";

const subscription: Subscription = {
  destinationChannelId: "destination",
  destinationGuildId: "guild",
  emailTo: "reader@example.test",
  id: "subscription",
};

describe("polling history pagination", () => {
  it("does not advance the cursor when a later page fails", async () => {
    let persisted = false;
    const ports: PollingPorts = {
      enqueue: () => Effect.void,
      repository: {
        cursor: () => Effect.succeed("100"),
        enabledSubscriptions: () => Effect.succeed([subscription]),
        initializeCursor: () => Effect.void,
        markEnqueued: () => Effect.void,
        pendingDeliveries: () => Effect.succeed([]),
        persistDiscoveryBatch: () =>
          Effect.sync(() => {
            persisted = true;
          }),
      },
      source: {
        fetchAfter: () =>
          Effect.succeed(
            Array.from({ length: 100 }, (_, index) => ({
              raw: { id: String(200 - index) },
            }))
          ),
        fetchBefore: () =>
          Effect.fail(new DiscordApiError("network error", 503, true)),
        fetchLatest: () => Effect.succeed([]),
        getWebhook: () => Effect.succeed(null),
      },
    };

    await expect(
      Effect.runPromise(
        pollAll.pipe(Effect.provide(pollingServiceLayer(ports)))
      )
    ).rejects.toThrow("network error");
    expect(persisted).toBeFalsy();
  });

  it("does not advance past an incomplete crosspost missing its webhook", async () => {
    let persisted = false;
    const ports: PollingPorts = {
      enqueue: () => Effect.void,
      repository: {
        cursor: () => Effect.succeed("100"),
        enabledSubscriptions: () => Effect.succeed([subscription]),
        initializeCursor: () => Effect.void,
        markEnqueued: () => Effect.void,
        pendingDeliveries: () => Effect.succeed([]),
        persistDiscoveryBatch: () =>
          Effect.sync(() => {
            persisted = true;
          }),
      },
      source: {
        fetchAfter: () => Effect.succeed([{ raw: { flags: 2, id: "101" } }]),
        fetchBefore: () => Effect.succeed([]),
        fetchLatest: () => Effect.succeed([]),
        getWebhook: () => Effect.succeed(null),
      },
    };

    await expect(
      Effect.runPromise(
        pollAll.pipe(Effect.provide(pollingServiceLayer(ports)))
      )
    ).rejects.toThrow("malformed crosspost candidate");
    expect(persisted).toBeFalsy();
  });
});
