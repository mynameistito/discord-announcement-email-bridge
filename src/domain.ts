import { Schema } from "effect";

/** Runtime contract for the source-message reference attached to a crosspost. */
const RefSchema = Schema.Struct({
  channel_id: Schema.String,
  guild_id: Schema.String,
  message_id: Schema.String,
});

/** Runtime contract for the author field used in announcement emails. */
const AuthorSchema = Schema.Struct({ username: Schema.String });

/** Runtime contract for attachment names and downloadable URLs. */
const AttachmentSchema = Schema.Struct({
  content_type: Schema.optionalKey(Schema.NullOr(Schema.String)),
  filename: Schema.String,
  url: Schema.String,
});

/** Runtime contract for the optional name and value of a Discord embed field. */
const EmbedFieldSchema = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.String),
});

/** Runtime contract for the subset of embed content rendered by the bridge. */
const EmbedSchema = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Schema.Array(EmbedFieldSchema)),
  image: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
  thumbnail: Schema.optionalKey(Schema.Struct({ url: Schema.String })),
  title: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
});

/**
 * Runtime validator for the Discord message fields used by classification,
 * persistence, and email rendering; unrelated Discord properties are ignored.
 */
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

/** Static message type inferred from {@link MessageSchema}. */
export type DiscordMessage = typeof MessageSchema.Type;

/** Runtime validator for webhook metadata used to verify Channel Follower origin. */
export const WebhookSchema = Schema.Struct({
  id: Schema.String,
  source_channel: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
  source_guild: Schema.optionalKey(Schema.Struct({ id: Schema.String })),
  type: Schema.Number,
});

/** Static webhook type inferred from {@link WebhookSchema}. */
export type FollowerWebhook = typeof WebhookSchema.Type;

/**
 * Configuration for one destination channel and its email recipient.
 * Optional source identifiers further constrain accepted follower crossposts.
 */
export interface Subscription {
  /** Durable identity for the configured destination subscription. */
  readonly id: string;
  /** Discord guild containing the followed destination channel. */
  readonly destinationGuildId: string;
  /** Discord channel containing follower copies to inspect. */
  readonly destinationChannelId: string;
  /** Email recipient for verified announcements. */
  readonly emailTo: string;
  /** Optional source guild allowlist for follower attribution. */
  readonly sourceGuildId?: string;
  /** Optional source channel allowlist for follower attribution. */
  readonly sourceChannelId?: string;
}

/** Runtime contract for optional source guild/channel email presentation data. */
export const SourceMetadataSchema = Schema.Struct({
  channelName: Schema.String,
  guildIconUrl: Schema.optionalKey(Schema.String),
  guildName: Schema.String,
});

/** Parsed metadata used to present an announcement in email. */
export type SourceMetadata = typeof SourceMetadataSchema.Type;

/**
 * A verified follower crosspost enriched with its source identifiers and
 * subscription identity for durable storage and later delivery.
 */
export interface Announcement {
  /** Subscription responsible for this discovered announcement. */
  readonly subscriptionId: string;
  /** Validated Discord follower-copy message used for rendering. */
  readonly message: DiscordMessage;
  /** Original source guild attributed by the follower reference. */
  readonly sourceGuildId: string;
  /** Original source channel attributed by the follower reference. */
  readonly sourceChannelId: string;
  /** Original source message snowflake attributed by the follower reference. */
  readonly sourceMessageId: string;
  /** Webhook ID whose metadata confirmed the follower relationship. */
  readonly followerWebhookId: string;
  /** Best-effort source names and icon URL resolved during discovery. */
  readonly sourceMetadata?: SourceMetadata;
}

/**
 * Check Discord's message flags for the crossposted bit.
 * @param flags - Numeric bitfield returned by Discord.
 * @returns Whether bit 1 (the crossposted flag) is set.
 */
export const hasCrosspostFlag = (flags: number): boolean =>
  flags >= 2 && Math.floor(flags / 2) % 2 === 1;

/**
 * Confirm that a message's webhook is the follower for its referenced source.
 * @param message - Follower-copy message to validate.
 * @param webhook - Retrieved webhook metadata, or `null` when missing.
 * @param reference - Source message reference attached to the copy.
 * @returns Whether the webhook metadata matches the referenced source.
 */
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

/**
 * Confirm that destination and optional configured source IDs match.
 * @param message - Follower-copy message to validate.
 * @param subscription - Configured destination and source constraints.
 * @param reference - Source message reference attached to the copy.
 * @returns Whether the message matches the configured subscription.
 */
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

/**
 * Classify a message only when Discord's crosspost flag, reference, follower
 * webhook metadata, destination, and configured source constraints agree.
 * @param message - Candidate message returned from the destination channel.
 * @param webhook - Webhook metadata associated with the candidate message.
 * @param subscription - Subscription whose constraints must match.
 * @returns The normalized announcement, or `undefined` for an unverified message.
 */
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

/**
 * Compare decimal Discord snowflake identifiers without losing 64-bit precision.
 * @param left - First decimal snowflake identifier.
 * @param right - Second decimal snowflake identifier.
 * @returns A negative value, zero, or positive value according to numeric order.
 */
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

/**
 * Return a new message array ordered oldest-first by Discord snowflake ID.
 * @param messages - Messages to order.
 * @returns A new array ordered by ascending snowflake ID.
 */
export const oldestFirst = (
  messages: readonly DiscordMessage[]
): readonly DiscordMessage[] =>
  messages.toSorted((left, right) => compareSnowflakes(left.id, right.id));

export { renderHtml, renderText } from "@/email-renderer";
