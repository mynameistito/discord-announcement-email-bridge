import type { Announcement, DiscordMessage } from "@/domain";
import { renderEmailMarkdown } from "@/email-markdown";

/** Escape HTML metacharacters before inserting untrusted Discord content. */
const escapeHtml = (value: string): string =>
  value.replaceAll(/[&<>"']/gu, (character) => {
    switch (character) {
      case '"':
        return "&quot;";
      case "&":
        return "&amp;";
      case "'":
        return "&#39;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      default:
        return character;
    }
  });

/** Allow only HTTP(S) destinations and escape them for safe HTML attributes. */
const escapeAttribute = (value: string): string =>
  /^https?:\/\//iu.test(value) ? escapeHtml(value) : "#";

/** Format a Discord timestamp in the agreed UTC email display format. */
const formatTimestamp = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: "UTC",
    year: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("hour")}:${part("minute")} ${part("day")}/${part("month")}/${part("year")}`;
};

/** Make remote image content clickable while keeping email markup simple. */
const linkedImage = (url: string, alt: string, style: string): string => {
  if (!/^https?:\/\//iu.test(url)) return "";
  const safeUrl = escapeAttribute(url);
  return `<a href="${safeUrl}"><img src="${safeUrl}" alt="${escapeHtml(alt)}" style="${style}" /></a>`;
};

/** Decide whether a Discord attachment should be embedded as an image. */
const isImageAttachment = (attachment: DiscordMessage["attachments"][number]) =>
  /^image\/(?:avif|gif|jpeg|png|webp)$/iu.test(attachment.content_type ?? "") ||
  /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(attachment.filename);

/** Build a stable Discord URL for the exact source announcement message. */
const discordMessageUrl = (announcement: Announcement): string =>
  [
    announcement.sourceGuildId,
    announcement.sourceChannelId,
    announcement.sourceMessageId,
  ]
    .map(encodeURIComponent)
    .reduce((url, id) => `${url}/${id}`, "https://discord.com/channels");

/** Render a Discord announcement as an HTML email body. */
export const renderHtml = (announcement: Announcement): string => {
  const { message } = announcement;
  const messageUrl = discordMessageUrl(announcement);
  const metadata = announcement.sourceMetadata;
  const server = metadata?.guildName ?? "Discord announcement";
  const channel = metadata?.channelName ?? announcement.sourceChannelId;
  const icon = metadata?.guildIconUrl
    ? linkedImage(
        metadata.guildIconUrl,
        server,
        "width:48px;height:48px;border-radius:50%;display:block;object-fit:cover"
      )
    : "";
  const header = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px"><tr>${icon ? `<td style="padding-right:12px">${icon}</td>` : ""}<td><strong>${escapeHtml(server)}</strong><br /><a href="${messageUrl}" style="color:#5865f2;text-decoration:none">#${escapeHtml(channel)}</a> <span style="color:#747f8d">· ${formatTimestamp(message.timestamp)} UTC</span><br /><span style="color:#747f8d">${escapeHtml(message.author.username)}</span></td></tr></table>`;
  const content = renderEmailMarkdown(message.content);
  const embeds = message.embeds.map(renderEmbed).join("");
  const attachments = message.attachments.map(renderAttachment).join("");
  return `<main>${header}<div>${content}</div>${embeds}${attachments}</main>`;
};

/** Render one Discord embed with formatted text and linked images. */
const renderEmbed = (embed: DiscordMessage["embeds"][number]): string => {
  const title = renderEmailMarkdown(embed.title ?? "");
  const description = renderEmailMarkdown(embed.description ?? "");
  const fields = (embed.fields ?? [])
    .map(
      (field) =>
        `<p><strong>${renderEmailMarkdown(field.name ?? "")}</strong> ${renderEmailMarkdown(field.value ?? "")}</p>`
    )
    .join("");
  const images = [embed.image?.url, embed.thumbnail?.url]
    .filter((url): url is string => url !== undefined)
    .map((url) =>
      linkedImage(
        url,
        embed.title ?? "Announcement image",
        "max-width:100%;height:auto"
      )
    )
    .join("");
  const link = embed.url
    ? `<p><a href="${escapeAttribute(embed.url)}">${escapeHtml(embed.url)}</a></p>`
    : "";
  return `<section><h2>${title}</h2><div>${description}</div>${fields}${images}${link}</section>`;
};

/** Render an image attachment inline and keep other files as download links. */
const renderAttachment = (
  attachment: DiscordMessage["attachments"][number]
): string =>
  isImageAttachment(attachment)
    ? linkedImage(
        attachment.url,
        attachment.filename,
        "display:block;max-width:100%;height:auto;margin:12px 0"
      )
    : `<p><a href="${escapeAttribute(attachment.url)}">${escapeHtml(attachment.filename)}</a></p>`;

/** Render an announcement as readable plain text. */
export const renderText = (announcement: Announcement): string => {
  const { message } = announcement;
  const metadata = announcement.sourceMetadata;
  const embeds = message.embeds
    .map((embed) =>
      [
        embed.title,
        embed.description,
        ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
        embed.url,
        embed.image?.url,
        embed.thumbnail?.url,
      ]
        .filter(Boolean)
        .join("\n")
    )
    .filter(Boolean)
    .join("\n\n");
  const attachments = message.attachments
    .map((item) => `${item.filename}: ${item.url}`)
    .join("\n");
  return [
    `${metadata?.guildName ?? "Discord announcement"} #${metadata?.channelName ?? announcement.sourceChannelId} · ${formatTimestamp(message.timestamp)} UTC · ${message.author.username}`,
    message.content,
    embeds,
    attachments,
    `View announcement: ${discordMessageUrl(announcement)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};
