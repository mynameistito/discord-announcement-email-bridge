import { Effect } from "effect";

import type { PollingPorts } from "@/application/polling";
import { BridgeInfrastructureError } from "@/bridge-infrastructure-error";
import type { Announcement, Subscription } from "@/domain";

/** Reusable subscription fixture for polling use-case tests. */
export const subscription: Subscription = {
  destinationChannelId: "target-channel",
  destinationGuildId: "target-guild",
  emailTo: "recipient@example.test",
  id: "sub",
};

/**
 * Build a valid followed crosspost fixture with the requested snowflake ID.
 * @param id - Discord message snowflake used by the fixture.
 * @returns A raw message object matching the followed-crosspost shape.
 */
export const crosspost = (id: string) => ({
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
});

/** Observable fake polling state used to assert persistence and enqueue order. */
export interface FakePollingPorts {
  readonly ports: PollingPorts;
  readonly cursor: () => string | undefined;
  readonly sent: () => readonly string[];
  readonly beforeValues: () => readonly string[];
  readonly discoveries: () => readonly Announcement[];
}

/**
 * Construct polling ports whose repository and source record test activity.
 * @param pages - Ordered fake Discord message pages.
 * @param initialCursor - Initial cursor, or `null` for an uninitialized channel.
 * @param failEnqueueCount - Number of initial queue attempts that should fail.
 * @returns Fake ports and read-only observations of test activity.
 */
export const fakePorts = (
  pages: readonly (readonly unknown[])[],
  initialCursor: string | null = "100",
  failEnqueueCount = 0
): FakePollingPorts => {
  let cursorValue: string | undefined = initialCursor ?? undefined;
  let initialized = initialCursor !== null;
  const discovered = new Map<string, string>();
  const storedAnnouncements: Announcement[] = [];
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
              announcementId: `announcement-${id}`,
              deliveryId: `delivery-${id}`,
              generation: "initial",
            }))
        ),
      persistDiscoveryBatch: (_subscription, discoveredBatch, cursor) =>
        Effect.sync(() => {
          for (const item of discoveredBatch) {
            discovered.set(item.message.id, item.message.id);
            storedAnnouncements.push(item);
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
      getSourceMetadata: () =>
        Effect.succeed({
          channelName: "announcements",
          guildName: "News server",
        }),
      getWebhook: (id) =>
        Effect.succeed({
          id,
          source_channel: { id: "source-channel" },
          source_guild: { id: "source-guild" },
          type: 2,
        }),
    },
  };
  return {
    beforeValues: () => beforeValues,
    cursor: () => (initialized ? (cursorValue ?? "0") : undefined),
    discoveries: () => storedAnnouncements,
    ports,
    sent: () => queued,
  };
};
