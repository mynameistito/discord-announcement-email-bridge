import { Schema } from "effect";

export const DiscordErrorPayloadSchema = Schema.Struct({
  code: Schema.Number,
  message: Schema.optional(Schema.String),
});

export type DiscordErrorPayload = typeof DiscordErrorPayloadSchema.Type;

interface SafeRoute {
  readonly name: string;
  readonly requiredPermissions?: string;
}

const safeRoute = (path: string): SafeRoute => {
  if (/^\/channels\/[^/]+\/messages(?:\?|$)/u.test(path)) {
    return {
      name: "/channels/{channel_id}/messages",
      requiredPermissions: "VIEW_CHANNEL, READ_MESSAGE_HISTORY",
    };
  }
  if (/^\/webhooks\/[^/]+(?:\/[^/?]+)?(?:\?|$)/u.test(path)) {
    return {
      name: "/webhooks/{webhook_id}",
      requiredPermissions: "MANAGE_WEBHOOKS in the destination channel",
    };
  }
  return { name: "an endpoint" };
};

const discordErrorMessage = (code: number | undefined): string | null => {
  switch (code) {
    case 50_001: {
      return "Missing Access";
    }
    case 50_013: {
      return "Missing Permissions";
    }
    default: {
      return null;
    }
  }
};

/** Describe a Discord REST failure without exposing resource IDs or response bodies. */
export const describeDiscordFailure = (
  path: string,
  status: number,
  payload: DiscordErrorPayload | null = null
): string => {
  const route = safeRoute(path);
  const message = discordErrorMessage(payload?.code);
  const messageDetail = message ? `: ${message}` : "";
  const errorDetail = payload
    ? `Discord error ${payload.code}${messageDetail}`
    : "";
  const permissionDetail =
    status === 403 && route.requiredPermissions
      ? `required bot permissions: ${route.requiredPermissions}`
      : "";
  const details = [errorDetail, permissionDetail].filter(Boolean).join("; ");
  const detail = details ? ` (${details})` : "";
  return `Discord REST GET ${route.name} returned ${status}${detail}`;
};
