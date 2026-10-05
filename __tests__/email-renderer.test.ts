import { describe, expect, it } from "vitest";

import { classifyFollowerMessage, renderHtml, renderText } from "@/domain";
import type { DiscordMessage, Subscription } from "@/domain";

const subscription: Subscription = {
  destinationChannelId: "channel-target",
  destinationGuildId: "guild-target",
  emailTo: "recipient@example.test",
  id: "sub-1",
};

const message = (overrides: Partial<DiscordMessage> = {}): DiscordMessage => ({
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
  id: "100",
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

const webhook = {
  id: "follower-hook",
  source_channel: { id: "source-channel" },
  source_guild: { id: "source-guild" },
  type: 2,
};

const classified = (candidate: DiscordMessage = message()) => {
  const result = classifyFollowerMessage(candidate, webhook, subscription);
  if (!result) {
    throw new Error("fixture should classify");
  }
  return result;
};

describe("announcement email rendering", () => {
  it("renders escaped content, attachments, embeds, and the source URL", () => {
    const announcement = classified();
    const html = renderHtml(announcement);
    const text = renderText(announcement);

    expect({
      attachmentLink: html.includes("https://cdn.discordapp.com/schedule.pdf"),
      attributedMessage: text.includes(
        "/source-guild/source-channel/source-message"
      ),
      embedField: text.includes("Status"),
      escapedContent: html.includes("&lt;noon&gt; &amp; stay tuned"),
      plainAttachment: text.includes("schedule.pdf"),
      rawHtml: html.includes("<noon>"),
    }).toStrictEqual({
      attachmentLink: true,
      attributedMessage: true,
      embedField: true,
      escapedContent: true,
      plainAttachment: true,
      rawHtml: false,
    });
  });

  it("renders linked metadata, UTC dates, inline images, and safe embed markup", () => {
    const announcement = classified(
      message({
        attachments: [
          {
            content_type: "image/jpeg",
            filename: "photo.jpg",
            url: "https://cdn.discordapp.com/photo.jpg",
          },
        ],
        content: "**Important update**",
        embeds: [
          {
            description: "**Details**",
            fields: [{ name: "Status", value: "*Planned*" }],
            image: { url: "https://tracker.example/pixel.png" },
            title: "Plain title",
          },
        ],
      })
    );
    const html = renderHtml({
      ...announcement,
      sourceMetadata: {
        channelName: "announcements",
        guildIconUrl: "https://cdn.discordapp.com/icons/source-guild/hash.png",
        guildName: "News server",
      },
    });

    expect([
      html.includes("border-radius:50%"),
      html.includes("News server"),
      html.includes(
        'href="https://discord.com/channels/source-guild/source-channel/source-message"'
      ),
      html.includes("#announcements"),
      html.includes("10:00 03/10/2026 UTC"),
      html.includes("<strong>Important update</strong>"),
      html.includes("<strong>Details</strong>"),
      html.includes("<h2>Plain title</h2>"),
      html.includes("<p><strong>Status</strong> <em>Planned</em></p>"),
      html.includes('href="https://tracker.example/pixel.png"'),
      !html.includes('src="https://tracker.example/pixel.png"'),
      html.includes(
        '<a href="https://cdn.discordapp.com/photo.jpg"><img src="https://cdn.discordapp.com/photo.jpg" alt="photo.jpg"'
      ),
    ]).toStrictEqual(Array.from({ length: 12 }, () => true));
  });

  it("escapes malformed timestamps before inserting them into HTML", () => {
    const html = renderHtml(
      classified(message({ timestamp: '<img src=x onerror="alert(1)" />' }))
    );

    expect([
      html.includes("&lt;img src=x onerror=&quot;alert(1)&quot; /&gt; UTC"),
      html.includes('<img src=x onerror="alert(1)" />'),
    ]).toStrictEqual([true, false]);
  });
});
