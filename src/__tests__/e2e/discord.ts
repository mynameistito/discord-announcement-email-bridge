import { readFile } from "node:fs/promises";

import { discordApi, jsonRequest, waitUntil } from "./http.ts";
import type { AnnouncementAttachment, E2EConfig, LogTone } from "./types.ts";

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

const headers = (token: string): Record<string, string> => ({
  Authorization: `Bot ${token}`,
});

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
  if (user.bot !== true)
    throw new Error(
      "DISCORD_PREVIEW_BOT_TOKEN did not authenticate a Discord bot account."
    );
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
  if (source.guild_id !== config.guildId || source.type !== 5)
    throw new Error(
      "Configured source channel is not an Announcement Channel in DISCORD_GUILD_ID"
    );
  if (receiver.guild_id !== config.guildId)
    throw new Error("Configured receiver channel is not in DISCORD_GUILD_ID");
  const webhooks = await jsonRequest<readonly DiscordWebhook[]>(
    `${discordApi}/channels/${config.receiverChannelId}/webhooks`,
    { headers: headers(config.token) },
    "List receiver-channel webhooks",
    signal
  );
  if (
    !webhooks.some(
      (webhook) =>
        webhook.type === 2 &&
        webhook.source_guild?.id === config.guildId &&
        webhook.source_channel?.id === config.sourceChannelId
    )
  ) {
    throw new Error(
      "E2E receiver channel is not following the configured source announcement channel"
    );
  }
  log(
    "Receiver channel is following the configured source channel.",
    "success"
  );
};

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
  if (!attachment) {
    init = {
      body: JSON.stringify({ content }),
      headers: { ...authorization, "Content-Type": "application/json" },
      method: "POST",
    };
  } else {
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
  }
  const created = await jsonRequest<{ readonly id?: string }>(
    url,
    init,
    "Create E2E announcement",
    signal
  );
  if (!created.id)
    throw new Error(
      `Discord did not return an announcement message ID for ${marker}`
    );
  return created.id;
};

export const crosspostAnnouncement = async (
  config: E2EConfig,
  messageId: string,
  signal: AbortSignal,
  log: Log
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
  if (!copy?.id)
    throw new Error("Discord follower copy did not include a message ID");
  if (!copy.attachments?.some(({ filename }) => filename === "e2e-photo.jpg"))
    throw new Error("Discord follower copy did not include the E2E photo");
  return copy.id;
};
