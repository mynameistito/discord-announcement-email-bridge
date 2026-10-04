import { Schema } from "effect";

export const DiscordErrorPayloadSchema = Schema.Struct({
  code: Schema.Number,
  message: Schema.optional(Schema.String),
});

export type DiscordErrorPayload = typeof DiscordErrorPayloadSchema.Type;

/** Describe a Discord REST failure without exposing resource IDs or response bodies. */
export function describeDiscordFailure(
  path: string,
  status: number,
  payload: DiscordErrorPayload | undefined
): string {
  const route = safeRoute(path);
  const message = discordErrorMessage(payload?.code);
  const messageDetail = message ? `: ${message}` : "";
  const detail = payload
    ? ` (Discord error ${payload.code}${messageDetail})`
    : "";
  return `Discord REST GET ${route} returned ${status}${detail}`;
}

function safeRoute(path: string): string {
  if (/^\/channels\/[^/]+\/messages(?:\?|$)/u.test(path)) {
    return "/channels/{channel_id}/messages";
  }
  if (/^\/webhooks\/[^/]+(?:\/[^/?]+)?(?:\?|$)/u.test(path)) {
    return "/webhooks/{webhook_id}";
  }
  return "an endpoint";
}

function discordErrorMessage(code: number | undefined): string | undefined {
  switch (code) {
    case 50_001: {
      return "Missing Access";
    }
    case 50_013: {
      return "Missing Permissions";
    }
    default: {
      return undefined;
    }
  }
}
