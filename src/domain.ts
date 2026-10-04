import { Schema } from "effect";

const RefSchema = Schema.Struct({
  channel_id: Schema.String,
  guild_id: Schema.String,
  message_id: Schema.String,
});

const AuthorSchema = Schema.Struct({ username: Schema.String });

const AttachmentSchema = Schema.Struct({
  filename: Schema.String,
  url: Schema.String,
});

const EmbedFieldSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
});

const EmbedSchema = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Schema.Array(EmbedFieldSchema)),
  image: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
  thumbnail: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});

/** Minimal message data consumed by classification and rendering. */
export const MessageSchema = Schema.Struct({
  attachments: Schema.Array(AttachmentSchema),
  author: AuthorSchema,
  channel_id: Schema.String,
  content: Schema.String,
  edited_timestamp: Schema.optionalKey(Schema.NullOr(Schema.String)),
  embeds: Schema.Array(EmbedSchema),
  flags: Schema.optionalKey(Schema.Number),
  id: Schema.String.check(Schema.isPattern(/^\d+$/u)),
  message_reference: Schema.optionalKey(RefSchema),
  timestamp: Schema.String,
  type: Schema.Number,
  webhook_id: Schema.optionalKey(Schema.String),
});

/** Parsed subset of a Discord message. */
export type DiscordMessage = typeof MessageSchema.Type;

/** External webhook metadata used to verify Channel Follower origin. */
export const WebhookSchema = Schema.Struct({
  id: Schema.String,
  source_channel: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
  source_guild: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
  type: Schema.Number,
});

/** Parse the webhook metadata subset required for follower verification. */
export type FollowerWebhook = typeof WebhookSchema.Type;

/** Configuration for one destination-channel subscription. */
export interface Subscription {
  readonly id: string;
  readonly destinationGuildId: string;
  readonly destinationChannelId: string;
  readonly emailTo: string;
  readonly sourceGuildId?: string;
  readonly sourceChannelId?: string;
}

/** Persistable classified crosspost. */
export interface Announcement {
  readonly subscriptionId: string;
  readonly message: DiscordMessage;
  readonly sourceGuildId: string;
  readonly sourceChannelId: string;
  readonly sourceMessageId: string;
  readonly followerWebhookId: string;
}

export const hasCrosspostFlag = (flags: number): boolean =>
  flags >= 2 && Math.floor(flags / 2) % 2 === 1;

const matchesFollowerWebhook = (
  message: DiscordMessage,
  webhook: FollowerWebhook | null,
  reference: NonNullable<DiscordMessage["message_reference"]>
): boolean => {
  if (!message.webhook_id || webhook?.id !== message.webhook_id) {
    return false;
  }
  if (webhook.type !== 2 || webhook.source_guild?.id !== reference.guild_id) {
    return false;
  }
  return webhook.source_channel?.id === reference.channel_id;
};

const matchesSubscription = (
  message: DiscordMessage,
  subscription: Subscription,
  reference: NonNullable<DiscordMessage["message_reference"]>
): boolean => {
  if (message.channel_id !== subscription.destinationChannelId) {
    return false;
  }
  if (
    subscription.sourceGuildId !== undefined &&
    reference.guild_id !== subscription.sourceGuildId
  ) {
    return false;
  }
  return (
    subscription.sourceChannelId === undefined ||
    reference.channel_id === subscription.sourceChannelId
  );
};

/** The only evidence accepted as a followed announcement copy. */
export const classifyFollowerMessage = (
  message: DiscordMessage,
  webhook: FollowerWebhook | null,
  subscription: Subscription
): Announcement | undefined => {
  const reference = message.message_reference;
  const isCrosspost = hasCrosspostFlag(message.flags ?? 0);
  if (
    !isCrosspost ||
    !reference ||
    !message.webhook_id ||
    !matchesFollowerWebhook(message, webhook, reference)
  ) {
    return undefined;
  }
  if (!matchesSubscription(message, subscription, reference)) {
    return undefined;
  }
  return {
    followerWebhookId: message.webhook_id,
    message,
    sourceChannelId: reference.channel_id,
    sourceGuildId: reference.guild_id,
    sourceMessageId: reference.message_id,
    subscriptionId: subscription.id,
  };
};

/** Compare Discord snowflakes without converting 64-bit values to Number. */
export const compareSnowflakes = (left: string, right: string): number => {
  const a = BigInt(left);
  const b = BigInt(right);
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

/** Sort messages in chronological order using their snowflake IDs. */
export const oldestFirst = (
  messages: readonly DiscordMessage[]
): readonly DiscordMessage[] =>
  messages.toSorted((left, right) => compareSnowflakes(left.id, right.id));

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

const escapeAttribute = (value: string): string => {
  if (!/^https?:\/\//iu.test(value)) {
    return "#";
  }
  return escapeHtml(value);
};

/** Render an HTML-escaped email for a discovered announcement. */
export const renderHtml = (announcement: Announcement): string => {
  const { message } = announcement;
  const content = escapeHtml(message.content);
  const embeds = message.embeds
    .map((embed) => {
      const fields = (embed.fields ?? [])
        .map(
          (field) =>
            `<p><strong>${escapeHtml(field.name ?? "")}</strong> ${escapeHtml(field.value ?? "")}</p>`
        )
        .join("");
      const links = [embed.url, embed.image?.url, embed.thumbnail?.url]
        .filter((url): url is string => url !== undefined)
        .map(
          (url) =>
            `<p><a href="${escapeAttribute(url)}">${escapeHtml(url)}</a></p>`
        )
        .join("");
      return `<section><h2>${escapeHtml(embed.title ?? "")}</h2><p>${escapeHtml(embed.description ?? "")}</p>${fields}${links}</section>`;
    })
    .join("");
  const attachments = message.attachments
    .map(
      (attachment) =>
        `<li><a href="${escapeAttribute(attachment.url)}">${escapeHtml(attachment.filename)}</a></li>`
    )
    .join("");
  return `<main><p><strong>${escapeHtml(message.author.username)}</strong> · ${escapeHtml(message.timestamp)}</p><p>${content}</p>${embeds}<ul>${attachments}</ul><p><a href="https://discord.com/channels/${announcement.sourceGuildId}/${announcement.sourceChannelId}/${announcement.sourceMessageId}">View announcement</a></p></main>`;
};

/** Render a text/plain email for a discovered announcement. */
export const renderText = (announcement: Announcement): string => {
  const { message } = announcement;
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
    `${message.author.username} · ${message.timestamp}`,
    message.content,
    embeds,
    attachments,
    `View announcement: https://discord.com/channels/${announcement.sourceGuildId}/${announcement.sourceChannelId}/${announcement.sourceMessageId}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};
