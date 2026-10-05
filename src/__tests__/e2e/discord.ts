import { readFile } from "node:fs/promises";

import { discordApi, jsonRequest, waitUntil } from "@/__tests__/e2e/http.ts";
import type {
  AnnouncementAttachment,
  E2EConfig,
  LogTone,
} from "@/__tests__/e2e/types.ts";

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
  attachment?: AnnouncementAttachment
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
    form.set("payload_json", JSON.stringify({ content }));
    const blobBytes = new Uint8Array(bytes.byteLength);
    blobBytes.set(bytes);
    form.set("files[0]", new Blob([blobBytes.buffer]), filename);
    init = { body: form, headers: authorization, method: "POST" };
  } else {
    init = {
      body: JSON.stringify({ content }),
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

/**
 * Crosspost the announcement and wait for its follower-channel copy.
 * @param config - E2E Discord credentials and channel IDs.
 * @param messageId - Original announcement identifier.
 * @param signal - Workflow cancellation signal.
 * @param log - Progress logger.
 * @param expectedFilename - Optional upload filename to verify in the copy.
 * @returns The follower copy message identifier.
 */
export const crosspostAnnouncement = async (
  config: E2EConfig,
  messageId: string,
  signal: AbortSignal,
  log: Log,
  expectedFilename?: string
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
      items.some((item) => item.message_reference?.message_id === messageId),
    2000,
    60_000,
    "Discord did not create the follower crosspost within 60 seconds",
    signal
  );
  const copy = messages.find(
    (item) => item.message_reference?.message_id === messageId
  );
  if (!copy?.id) {
    throw new Error("Discord follower copy did not include a message ID");
  }
  if (
    expectedFilename &&
    !copy.attachments?.some(({ filename }) => filename === expectedFilename)
  ) {
    throw new Error(
      `Discord follower copy did not include attachment ${expectedFilename}`
    );
  }
  return copy.id;
};
