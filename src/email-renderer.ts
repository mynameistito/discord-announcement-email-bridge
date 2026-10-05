import type { Announcement, DiscordMessage } from "@/domain";
import { renderEmailMarkdown } from "@/email-markdown";
import { renderInline } from "@/email-markdown-inline";

/**
 * Escape HTML metacharacters before inserting untrusted Discord content.
 * @param value - Untrusted text.
 * @returns Escaped HTML text.
 */
const escapeHtml = (value: string): string =>
  value.replaceAll(/[&<>"']/gu, (character) => {
    switch (character) {
      case '"': {
        return "&quot;";
      }
      case "&": {
        return "&amp;";
      }
      case "'": {
        return "&#39;";
      }
      case "<": {
        return "&lt;";
      }
      case ">": {
        return "&gt;";
      }
      default: {
        return character;
      }
    }
  });

/**
 * Allow only HTTP(S) destinations and escape them for safe HTML attributes.
 * @param value - Candidate URL.
 * @returns Safe escaped URL or a harmless placeholder.
 */
const escapeAttribute = (value: string): string =>
  /^https?:\/\//iu.test(value) ? escapeHtml(value) : "#";

/**
 * Format a Discord timestamp in the agreed UTC email display format.
 * @param value - Discord timestamp.
 * @returns UTC timestamp in the email display format.
 */
const formatTimestamp = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
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

/**
 * Restrict automatically loaded email images to Discord-owned media hosts.
 * @param value - Candidate image URL.
 * @returns Whether the URL uses a Discord-owned HTTPS media host.
 */
const isDiscordMediaUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      ["discordapp.com", "discordapp.net"].some(
        (domain) =>
          url.hostname === domain || url.hostname.endsWith(`.${domain}`)
      )
    );
  } catch {
    return false;
  }
};

/**
 * Make remote image content clickable while keeping email markup simple.
 * @param url - Image URL.
 * @param alt - Image alternative text.
 * @param style - Inline image style.
 * @returns Linked image HTML, or an empty string for an unsafe URL.
 */
const linkedImage = (url: string, alt: string, style: string): string => {
  if (!isDiscordMediaUrl(url)) {
    return "";
  }
  const safeUrl = escapeAttribute(url);
  return `<a href="${safeUrl}"><img src="${safeUrl}" alt="${escapeHtml(alt)}" style="${style}" /></a>`;
};

/**
 * Decide whether a Discord attachment should be embedded as an image.
 * @param attachment - Discord attachment metadata.
 * @returns Whether the attachment is an image.
 */
const isImageAttachment = (attachment: DiscordMessage["attachments"][number]) =>
  /^image\/(?:avif|gif|jpeg|png|webp)$/iu.test(attachment.content_type ?? "") ||
  /\.(?:avif|gif|jpe?g|png|webp)$/iu.test(attachment.filename);

/**
 * Build a stable Discord URL for the exact source announcement message.
 * @param announcement - Source announcement.
 * @returns Canonical Discord message URL.
 */
const discordMessageUrl = (announcement: Announcement): string =>
  `https://discord.com/channels/${encodeURIComponent(announcement.sourceGuildId)}/${encodeURIComponent(announcement.sourceChannelId)}/${encodeURIComponent(announcement.sourceMessageId)}`;

const renderEmbedAuthor = (embed: DiscordMessage["embeds"][number]): string => {
  const { author } = embed;
  if (!author?.name) {
    return "";
  }
  const name = renderInline(author.name);
  const linkedName = author.url
    ? `<a href="${escapeAttribute(author.url)}">${name}</a>`
    : name;
  const icon = author.icon_url
    ? linkedImage(
        author.icon_url,
        author.name,
        "width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:6px"
      )
    : "";
  return `<p>${icon}${linkedName}</p>`;
};

const renderEmbedFooter = (embed: DiscordMessage["embeds"][number]): string => {
  const icon = embed.footer?.icon_url
    ? linkedImage(
        embed.footer.icon_url,
        "",
        "width:16px;height:16px;vertical-align:middle;margin-right:6px"
      )
    : "";
  const text = embed.footer ? renderInline(embed.footer.text) : "";
  const timestamp = embed.timestamp
    ? ` · ${escapeHtml(formatTimestamp(embed.timestamp))} UTC`
    : "";
  if (!text && !timestamp) {
    return "";
  }
  return `<p>${icon}${text}${timestamp}</p>`;
};

const embedBorderColor = (color: number | undefined): string => {
  if (
    color === undefined ||
    !Number.isSafeInteger(color) ||
    color < 0 ||
    color > 0xff_ff_ff
  ) {
    return "";
  }
  return ` style="border-left:4px solid #${color.toString(16).padStart(6, "0")};padding-left:12px"`;
};

const renderEmbedThumbnail = (
  embed: DiscordMessage["embeds"][number]
): string => {
  const url = embed.thumbnail?.url;
  if (!url) {
    return "";
  }
  const image = linkedImage(
    url,
    embed.title ?? "Announcement thumbnail",
    "display:block;width:80px;height:80px;max-width:80px;object-fit:cover;border-radius:8px"
  );
  const linkedUrl = `<a href="${escapeAttribute(url)}">${escapeHtml(url)}</a>`;
  return `<td width="80" valign="top" style="width:80px;padding:0 0 12px 12px">${image || linkedUrl}</td>`;
};

/**
 * Render one Discord embed with formatted text and linked images.
 * @param embed - Discord embed data.
 * @returns Email-safe embed HTML.
 */
const renderEmbed = (embed: DiscordMessage["embeds"][number]): string => {
  const title = renderInline(embed.title ?? "");
  const linkedTitle = embed.url
    ? `<a href="${escapeAttribute(embed.url)}">${title}</a>`
    : title;
  const author = renderEmbedAuthor(embed);
  const description = renderEmailMarkdown(embed.description ?? "");
  const fields = (embed.fields ?? [])
    .map(
      (field) =>
        `<p><strong>${renderInline(field.name ?? "")}</strong> ${renderInline(field.value ?? "")}</p>`
    )
    .join("");
  const thumbnail = renderEmbedThumbnail(embed);
  const content = `<div>${author}<h2>${linkedTitle}</h2><div>${description}</div>${fields}</div>`;
  const mainContent = thumbnail
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td valign="top">${content}</td>${thumbnail}</tr></table>`
    : content;
  const imageUrl = embed.image?.url;
  const image = imageUrl
    ? linkedImage(
        imageUrl,
        embed.title ?? "Announcement image",
        "display:block;max-width:100%;height:auto;margin:12px 0"
      ) ||
      `<p><a href="${escapeAttribute(imageUrl)}">${escapeHtml(imageUrl)}</a></p>`
    : "";
  const footer = renderEmbedFooter(embed);
  return `<section${embedBorderColor(embed.color)}>${mainContent}${image}${footer}</section>`;
};

/**
 * Render an image attachment inline and keep other files as download links.
 * @param attachment - Discord attachment.
 * @returns HTML for the image or its download link.
 */
const renderAttachment = (
  attachment: DiscordMessage["attachments"][number]
): string =>
  isImageAttachment(attachment)
    ? linkedImage(
        attachment.url,
        attachment.filename,
        "display:block;max-width:100%;height:auto;margin:12px 0"
      ) ||
      `<p><a href="${escapeAttribute(attachment.url)}">${escapeHtml(attachment.filename)}</a></p>`
    : `<p><a href="${escapeAttribute(attachment.url)}">${escapeHtml(attachment.filename)}</a></p>`;

/**
 * Render a Discord announcement as an HTML email body.
 * @param announcement - Announcement to render.
 * @returns Email-safe HTML body.
 */
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
  const iconCell = icon ? `<td style="padding-right:12px">${icon}</td>` : "";
  const header = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin-bottom:24px"><tr>${iconCell}<td><strong>${escapeHtml(server)}</strong><br /><a href="${messageUrl}" style="color:#5865f2;text-decoration:none">#${escapeHtml(channel)}</a> <span style="color:#747f8d">· ${escapeHtml(formatTimestamp(message.timestamp))} UTC</span><br /><span style="color:#747f8d">${escapeHtml(message.author.username)}</span></td></tr></table>`;
  const content = renderEmailMarkdown(message.content);
  const embeds = message.embeds.map(renderEmbed).join("");
  const embedImages = new Set(
    message.embeds.flatMap((embed) =>
      [embed.image?.url, embed.thumbnail?.url].filter(
        (url): url is string => url !== undefined
      )
    )
  );
  const attachments = message.attachments
    .filter((attachment) => !embedImages.has(attachment.url))
    .map(renderAttachment)
    .join("");
  return `<main>${header}<div>${content}</div>${embeds}${attachments}</main>`;
};

/**
 * Render an announcement as readable plain text.
 * @param announcement - Announcement to render.
 * @returns Plain-text email body.
 */
export const renderText = (announcement: Announcement): string => {
  const { message } = announcement;
  const metadata = announcement.sourceMetadata;
  const embeds = message.embeds
    .map((embed) =>
      [
        embed.title,
        embed.author?.name,
        embed.description,
        ...(embed.fields ?? []).flatMap((field) => [field.name, field.value]),
        embed.url,
        embed.image?.url,
        embed.thumbnail?.url,
        embed.footer?.text,
        embed.timestamp,
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
