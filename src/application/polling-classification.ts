import { Effect } from "effect";

import type { PollingPorts } from "@/application/polling";
import { classifyFollowerMessage, hasCrosspostFlag } from "@/domain";
import type {
  Announcement,
  DiscordMessage,
  FollowerWebhook,
  SourceMetadata,
  Subscription,
} from "@/domain";

const sourceMetadataFromWebhook = (
  webhook: FollowerWebhook | null
): SourceMetadata | undefined => {
  const guild = webhook?.source_guild;
  const channel = webhook?.source_channel;
  if (!guild?.name || !channel?.name) {
    return undefined;
  }
  const iconHash = guild.icon;
  const metadata = {
    channelName: channel.name,
    guildName: guild.name,
  };
  if (!iconHash) {
    return metadata;
  }
  const extension = iconHash.startsWith("a_") ? "gif" : "png";
  return {
    ...metadata,
    guildIconUrl: `https://cdn.discordapp.com/icons/${encodeURIComponent(guild.id)}/${encodeURIComponent(iconHash)}.${extension}?size=128`,
  };
};

/**
 * Determine whether the message has content worth sending in an email.
 * @param message - Candidate message to inspect.
 * @returns Whether the message contains text, embeds, or attachments.
 */
const hasReadableContent = (message: DiscordMessage): boolean =>
  Boolean(message.content) ||
  message.embeds.length > 0 ||
  message.attachments.length > 0;

/**
 * Verify follower webhooks and source constraints, cache each webhook lookup,
 * and retain only announcements that contain renderable content.
 * @param ports - Discord source used to retrieve webhook metadata.
 * @param subscription - Subscription constraints applied to each message.
 * @param messages - Candidate destination-channel messages.
 * @returns An Effect containing verified, renderable announcements.
 */
export const classifyMessages = (
  ports: PollingPorts,
  subscription: Subscription,
  messages: readonly DiscordMessage[]
) =>
  Effect.gen(function* classifyMessagesEffect() {
    const announcements: Announcement[] = [];
    const webhooks = new Map<string, FollowerWebhook | null>();
    const sourceMetadata = new Map<
      string,
      Announcement["sourceMetadata"] | null
    >();
    for (const message of messages) {
      if (!message.webhook_id || !hasCrosspostFlag(message.flags ?? 0)) {
        continue;
      }
      let webhook = webhooks.get(message.webhook_id) ?? null;
      if (!webhooks.has(message.webhook_id)) {
        webhook = yield* ports.source.getWebhook(message.webhook_id).pipe(
          Effect.catchIf(
            (error) => error.status === 404,
            () => Effect.succeed(null)
          )
        );
        webhooks.set(message.webhook_id, webhook);
      }
      const announcement = classifyFollowerMessage(
        message,
        webhook,
        subscription
      );
      if (announcement && hasReadableContent(message)) {
        const key = `${announcement.sourceGuildId}:${announcement.sourceChannelId}`;
        if (!sourceMetadata.has(key)) {
          const webhookMetadata = sourceMetadataFromWebhook(webhook);
          const metadata =
            webhookMetadata ??
            (yield* ports.source
              .getSourceMetadata(
                announcement.sourceGuildId,
                announcement.sourceChannelId
              )
              .pipe(
                Effect.tapError(() =>
                  Effect.logWarning(
                    "announcement.source_metadata_unavailable",
                    {
                      channelId: announcement.sourceChannelId,
                      guildId: announcement.sourceGuildId,
                    }
                  )
                ),
                Effect.catchIf(
                  () => true,
                  () => Effect.succeed(null)
                )
              ));
          sourceMetadata.set(key, metadata);
        }
        const metadata = sourceMetadata.get(key);
        if (metadata) {
          announcements.push({ ...announcement, sourceMetadata: metadata });
        } else {
          announcements.push(announcement);
        }
      } else if (announcement) {
        console.warn(
          JSON.stringify({
            event: "announcement.content_unavailable",
            messageId: message.id,
            subscriptionId: subscription.id,
          })
        );
      }
    }
    return announcements;
  });
