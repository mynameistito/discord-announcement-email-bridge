import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  classifyFollowerMessage,
  compareSnowflakes,
  MessageSchema,
  oldestFirst,
  renderHtml,
  renderText,
} from "@/domain";
import type { DiscordMessage, Subscription } from "@/domain";

/** Reusable destination configuration for domain classification scenarios. */
const subscription: Subscription = {
  destinationChannelId: "channel-target",
  destinationGuildId: "guild-target",
  emailTo: "recipient@example.test",
  id: "sub-1",
};

/**
 * Build a valid message fixture with a chosen ID and selective overrides.
 * @param id - Discord message snowflake used by the fixture.
 * @param overrides - Optional message fields that replace fixture defaults.
 * @returns A valid Discord message for domain tests.
 */
const message = (
  id: string,
  overrides: Partial<DiscordMessage> = {}
): DiscordMessage => ({
  attachments: [
    {
      filename: "schedule.pdf",
      url: "https://cdn.discordapp.com/schedule.pdf",
    },
  ],
  author: { username: "source news" },
  channel_id: "channel-target",
  content: "Service maintenance at <noon> & stay tuned",
  embeds: [
    {
      description: "Details",
      fields: [{ name: "Status", value: "Planned" }],
      title: "Update",
    },
  ],
  flags: 2,
  id,
  message_reference: {
    channel_id: "source-channel",
    guild_id: "source-guild",
    message_id: "source-message",
  },
  timestamp: "2026-10-03T10:00:00Z",
  type: 0,
  webhook_id: "follower-hook",
  ...overrides,
});

/** Follower webhook fixture matching the source IDs in the message helper. */
const webhook = {
  id: "follower-hook",
  source_channel: { id: "source-channel" },
  source_guild: { id: "source-guild" },
  type: 2,
};

describe("Discord payloads and follower classification", () => {
  it("decodes the required untrusted message subset", async () => {
    const decoded = await Effect.runPromise(
      Schema.decodeUnknownEffect(MessageSchema)(message("100"))
    );
    expect(decoded.id).toBe("100");
  });

  it("rejects malformed payloads", async () => {
    await expect(
      Effect.runPromise(Schema.decodeUnknownEffect(MessageSchema)({ id: 1 }))
    ).rejects.toBeInstanceOf(Schema.SchemaError);
    await expect(
      Effect.runPromise(
        Schema.decodeUnknownEffect(MessageSchema)(message("not-a-snowflake"))
      )
    ).rejects.toBeInstanceOf(Schema.SchemaError);
  });

  it("accepts only crossposts from a matching type-2 follower webhook", () => {
    const result = classifyFollowerMessage(
      message("100"),
      webhook,
      subscription
    );
    expect(result?.sourceMessageId).toBe("source-message");
  });

  it("rejects member messages", () => {
    expect(
      classifyFollowerMessage(
        message("101", { flags: 0 }),
        webhook,
        subscription
      )
    ).toBeUndefined();
  });

  it("rejects ordinary incoming webhook messages", () => {
    expect(
      classifyFollowerMessage(
        message("102"),
        { ...webhook, type: 1 },
        subscription
      )
    ).toBeUndefined();
  });

  it("rejects application webhook messages", () => {
    expect(
      classifyFollowerMessage(
        message("103"),
        { ...webhook, type: 3 },
        subscription
      )
    ).toBeUndefined();
  });

  it("rejects a webhook whose source does not match message attribution", () => {
    expect(
      classifyFollowerMessage(
        message("104"),
        { ...webhook, source_channel: { id: "wrong" } },
        subscription
      )
    ).toBeUndefined();
  });
});

describe("snowflakes and email rendering", () => {
  it("orders large snowflakes without unsafe Number conversion", () => {
    expect(compareSnowflakes("175928847299117063", "175928847299117064")).toBe(
      -1
    );
    expect(
      oldestFirst([
        message("90071992547409930"),
        message("9007199254740992"),
      ]).map(({ id }) => id)
    ).toStrictEqual(["9007199254740992", "90071992547409930"]);
  });

  it("renders text, embeds, attachment links and an attributed message URL", () => {
    const announcement = classifyFollowerMessage(
      message("100"),
      webhook,
      subscription
    );
    if (!announcement) {
      throw new Error("fixture should classify");
    }
    const text = renderText(announcement);
    const html = renderHtml(announcement);
    expect({
      hasAttachmentLink: html.includes(
        "https://cdn.discordapp.com/schedule.pdf"
      ),
      hasAttributedMessageUrl: text.includes(
        "/source-guild/source-channel/source-message"
      ),
      hasEmbedField: text.includes("Status"),
      hasEscapedContent: html.includes("&lt;noon&gt; &amp; stay tuned"),
      hasPlainAttachment: text.includes("schedule.pdf"),
      hasRawHtml: html.includes("<noon>"),
    }).toStrictEqual({
      hasAttachmentLink: true,
      hasAttributedMessageUrl: true,
      hasEmbedField: true,
      hasEscapedContent: true,
      hasPlainAttachment: true,
      hasRawHtml: false,
    });
  });
});
