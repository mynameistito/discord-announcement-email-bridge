import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { idempotencyKey } from "@/adapters/idempotency-key";
import type { Announcement } from "@/domain";

const announcement: Announcement = {
  followerWebhookId: "webhook",
  message: {
    attachments: [],
    author: { username: "news" },
    channel_id: "destination",
    content: "Update",
    embeds: [],
    id: "100",
    message_reference: {
      channel_id: "source",
      guild_id: "guild",
      message_id: "100",
    },
    timestamp: "2026-10-03T10:00:00Z",
    type: 0,
    webhook_id: "webhook",
  },
  sourceChannelId: "source",
  sourceGuildId: "guild",
  sourceMessageId: "100",
  subscriptionId: "sub-1",
};

describe("delivery idempotency key adapter", () => {
  it("is stable across recipient casing and scopes keys by recipient", async () => {
    const [first, normalized, otherRecipient] = await Promise.all([
      Effect.runPromise(idempotencyKey(announcement, "recipient@example.test")),
      Effect.runPromise(idempotencyKey(announcement, "RECIPIENT@example.test")),
      Effect.runPromise(idempotencyKey(announcement, "other@example.test")),
    ]);

    expect(first).toMatch(/^discord-follow\/sub-1\/100\/[a-f0-9]{64}$/u);
    expect(normalized).toBe(first);
    expect(otherRecipient).not.toBe(first);
  });
});
