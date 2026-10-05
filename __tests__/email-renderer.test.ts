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

  it("renders rich embed authors, icons, colors, images, and footers", () => {
    const imageUrl = "https://cdn.discordapp.com/attachments/e2e/photo.jpg";
    const announcement = classified(
      message({
        attachments: [
          { content_type: "image/jpeg", filename: "photo.jpg", url: imageUrl },
        ],
        embeds: [
          {
            author: {
              icon_url: "https://cdn.discordapp.com/embed/avatars/0.png",
              name: "E2E author",
              url: "https://example.com/author",
            },
            color: 5_793_266,
            description: "Embed details",
            fields: [{ inline: true, name: "Status", value: "Ready" }],
            footer: {
              icon_url: "https://cdn.discordapp.com/embed/avatars/1.png",
              text: "E2E footer",
            },
            image: { url: imageUrl },
            thumbnail: {
              url: "https://cdn.discordapp.com/embed/avatars/2.png",
            },
            timestamp: "2026-10-05T12:00:00.000Z",
            title: "Rich embed",
            url: "https://example.com/embed",
          },
        ],
      })
    );
    const html = renderHtml(announcement);
    const text = renderText(announcement);

    expect([
      html.includes("border-left:4px solid #5865f2"),
      html.includes('href="https://example.com/author">E2E author</a>'),
      html.includes('src="https://cdn.discordapp.com/embed/avatars/0.png"'),
      html.includes('src="https://cdn.discordapp.com/embed/avatars/1.png"'),
      html.includes('<a href="https://example.com/embed">Rich embed</a>'),
      html.includes('src="https://cdn.discordapp.com/embed/avatars/2.png"'),
      html.includes(
        'width="80" valign="top" style="width:80px;padding:0 0 12px 12px"'
      ),
      html.includes(
        "width:80px;height:80px;max-width:80px;object-fit:cover;border-radius:8px"
      ),
      html.includes("E2E footer · 12:00 05/10/2026 UTC"),
      html.includes(
        `src="${imageUrl}" alt="Rich embed" style="display:block;max-width:100%;height:auto;margin:12px 0"`
      ),
      !html.includes('alt="photo.jpg"'),
      text.includes("E2E author"),
      text.includes("E2E footer"),
    ]).toStrictEqual(Array.from({ length: 13 }, () => true));
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
