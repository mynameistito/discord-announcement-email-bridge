import { readFile } from "node:fs/promises";

import { discordApi, jsonRequest, waitUntil } from "@tests/e2e/http.ts";
import type {
  AnnouncementAttachment,
  E2EAnnouncementEmbed,
  E2EConfig,
  LogTone,
} from "@tests/e2e/types.ts";

type Log = (message: string, tone?: LogTone) => void;

interface DiscordChannel {
  readonly guild_id: string;
  readonly type: number;
}
interface DiscordWebhook {
  readonly type: number;
  readonly source_guild?: { readonly id: string } | null;
  readonly source_channel?: { readonly id: string } | null;
}
interface DiscordMessage {
  readonly id?: string;
  readonly message_reference?: { readonly message_id?: string } | null;
  readonly attachments?: readonly { readonly filename: string }[];
  readonly embeds?: readonly {
    readonly author?: {
      readonly icon_url?: string;
      readonly name?: string;
    } | null;
    readonly fields?: readonly { readonly name?: string }[];
    readonly footer?: {
      readonly icon_url?: string;
      readonly text?: string;
    } | null;
    readonly image?: { readonly url?: string } | null;
    readonly thumbnail?: { readonly url?: string } | null;
    readonly title?: string;
  }[];
}

const headers = (token: string) => ({
  Authorization: `Bot ${token}`,
});

/**
 * Verify the bot, configured channels, and follower webhook.
 * @param config - E2E Discord credentials and channel IDs.
 * @param signal - Workflow cancellation signal.
 * @param log - Progress logger.
 * @returns Promise resolved when Discord configuration is valid.
 */
export const verifyDiscord = async (
  config: E2EConfig,
  signal: AbortSignal,
  log: Log
): Promise<void> => {
  const user = await jsonRequest<{ readonly bot?: boolean }>(
    `${discordApi}/users/@me`,
    { headers: headers(config.token) },
    "Authenticate preview bot",
    signal
  );
  if (user.bot !== true) {
    throw new Error(
      "DISCORD_PREVIEW_BOT_TOKEN did not authenticate a Discord bot account."
    );
  }
  log("Authenticated the Discord preview bot.", "success");
  const [source, receiver] = await Promise.all([
    jsonRequest<DiscordChannel>(
      `${discordApi}/channels/${config.sourceChannelId}`,
      { headers: headers(config.token) },
      "Read source channel",
      signal
    ),
    jsonRequest<DiscordChannel>(
      `${discordApi}/channels/${config.receiverChannelId}`,
      { headers: headers(config.token) },
      "Read receiver channel",
      signal
    ),
  ]);
  if (source.guild_id !== config.guildId || source.type !== 5) {
    throw new Error(
      "Configured source channel is not an Announcement Channel in DISCORD_GUILD_ID"
    );
  }
  if (receiver.guild_id !== config.guildId) {
    throw new Error("Configured receiver channel is not in DISCORD_GUILD_ID");
  }
  const webhooks = await jsonRequest<readonly DiscordWebhook[]>(
    `${discordApi}/channels/${config.receiverChannelId}/webhooks`,
    { headers: headers(config.token) },
    "List receiver-channel webhooks",
    signal
  );
  if (
    webhooks.some(
      (webhook) =>
        webhook.type === 2 &&
        webhook.source_guild?.id === config.guildId &&
        webhook.source_channel?.id === config.sourceChannelId
    )
  ) {
    log(
      "Receiver channel is following the configured source channel.",
      "success"
    );
    return;
  }
  throw new Error(
    "E2E receiver channel is not following the configured source announcement channel"
  );
};

/**
 * Create an announcement message, optionally including an image attachment.
 * @param config - E2E Discord credentials and channel IDs.
 * @param marker - Unique marker used to identify the test post.
 * @param content - Message content.
 * @param signal - Workflow cancellation signal.
 * @param attachment - Optional image to upload with the post.
 * @returns The created Discord message identifier.
 */
export const createAnnouncement = async (
  config: E2EConfig,
  marker: string,
  content: string,
  signal: AbortSignal,
  attachment?: AnnouncementAttachment,
  embeds?: readonly E2EAnnouncementEmbed[]
): Promise<string> => {
  const url = `${discordApi}/channels/${config.sourceChannelId}/messages`;
  const authorization = headers(config.token);
  let init: RequestInit;
  if (attachment) {
    const bytes =
      attachment.kind === "bytes"
        ? attachment.bytes
        : await readFile(attachment.path);
    const filename =
      attachment.kind === "bytes"
        ? attachment.filename
        : (attachment.filename ??
          attachment.path.split(/[\\/]/u).at(-1) ??
          "fixture.bin");
    const form = new FormData();
    form.set("payload_json", JSON.stringify({ content, embeds }));
    const blobBytes = new Uint8Array(bytes.byteLength);
    blobBytes.set(bytes);
    form.set("files[0]", new Blob([blobBytes.buffer]), filename);
    init = { body: form, headers: authorization, method: "POST" };
  } else {
    init = {
      body: JSON.stringify({ content, embeds }),
      headers: { ...authorization, "Content-Type": "application/json" },
      method: "POST",
    };
  }
  const created = await jsonRequest<{ readonly id?: string }>(
    url,
    init,
    "Create E2E announcement",
    signal
  );
  if (!created.id) {
    throw new Error(
      `Discord did not return an announcement message ID for ${marker}`
    );
  }
  return created.id;
};

const preservesRichEmbed = (
  message: DiscordMessage,
  expectedTitle: string
): boolean => {
  const embed = message.embeds?.find((item) => item.title === expectedTitle);
  if (!embed?.author?.name || !embed.author.icon_url) {
    return false;
  }
  if (!embed.fields?.some((field) => field.name === "Status")) {
    return false;
  }
  if (!embed.footer?.text || !embed.footer.icon_url) {
    return false;
  }
  if (!embed.image?.url?.startsWith("https://")) {
    return false;
  }
  return Boolean(embed.thumbnail?.url?.startsWith("https://"));
};

/**
 * Check whether a follower copy has propagated with all expected content.
 * @param message - Message returned from the receiver channel.
 * @param messageId - Source announcement identifier.
 * @param expectedFilename - Optional upload filename to verify in the copy.
 * @param expectedEmbedTitle - Optional rich embed title to verify in the copy.
 * @returns Whether this is a complete follower copy for the announcement.
 */
export const isCompleteFollowerCopy = (
  message: DiscordMessage,
  messageId: string,
  expectedFilename?: string,
  expectedEmbedTitle?: string
): boolean => {
  if (!message.id || message.message_reference?.message_id !== messageId) {
    return false;
  }
  if (
    expectedFilename &&
    !message.attachments?.some(({ filename }) => filename === expectedFilename)
  ) {
    return false;
  }
  return !expectedEmbedTitle || preservesRichEmbed(message, expectedEmbedTitle);
};

/**
 * Crosspost the announcement and wait for its follower-channel copy.
 * @param config - E2E Discord credentials and channel IDs.
 * @param messageId - Original announcement identifier.
 * @param signal - Workflow cancellation signal.
 * @param log - Progress logger.
 * @param expectedFilename - Optional upload filename to verify in the copy.
 * @param expectedEmbedTitle - Optional rich embed title to verify in the copy.
 * @returns The follower copy message identifier.
 */
export const crosspostAnnouncement = async (
  config: E2EConfig,
  messageId: string,
  signal: AbortSignal,
  log: Log,
  expectedFilename?: string,
  expectedEmbedTitle?: string
): Promise<string> => {
  await jsonRequest<DiscordMessage>(
    `${discordApi}/channels/${config.sourceChannelId}/messages/${messageId}/crosspost`,
    { headers: headers(config.token), method: "POST" },
    "Crosspost E2E announcement",
    signal
  );
  log("Crossposted announcement; waiting for the follower copy...");
  const messages = await waitUntil(
    (probeSignal) =>
      jsonRequest<readonly DiscordMessage[]>(
        `${discordApi}/channels/${config.receiverChannelId}/messages?limit=100`,
        { headers: headers(config.token), signal: probeSignal },
        "Read receiver messages",
        signal
      ),
    (items) =>
      items.some((item) =>
        isCompleteFollowerCopy(
          item,
          messageId,
          expectedFilename,
          expectedEmbedTitle
        )
      ),
    2000,
    60_000,
    "Discord follower copy did not become complete with the expected content within 60 seconds",
    signal
  );
  const copy = messages.find((item) =>
    isCompleteFollowerCopy(
      item,
      messageId,
      expectedFilename,
      expectedEmbedTitle
    )
  );
  if (!copy?.id) {
    throw new Error(
      "Discord follower copy did not become complete with the expected content"
    );
  }
  return copy.id;
};
