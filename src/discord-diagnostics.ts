import { Schema } from "effect";

/** Runtime validator for the safe Discord error fields used in diagnostics. */
export const DiscordErrorPayloadSchema = Schema.Struct({
  code: Schema.Number,
  message: Schema.optional(Schema.String),
});

/** Static type inferred from {@link DiscordErrorPayloadSchema}. */
export type DiscordErrorPayload = typeof DiscordErrorPayloadSchema.Type;

/** Sanitized route metadata that never contains actual Discord resource IDs. */
interface SafeRoute {
  readonly name: string;
  readonly requiredPermissions?: string;
}

/**
 * Replace known resource paths with templates and their required permissions.
 * @param path - Discord API path that may include sensitive resource IDs.
 * @returns A safe route template and any relevant permission guidance.
 */
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

/**
 * Resolve known Discord error codes to safe, stable human-readable labels.
 * @param code - Discord error code to interpret.
 * @returns A stable label for known codes, or `null` otherwise.
 */
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

/**
 * Describe a Discord REST failure using a templated route and selected error
 * metadata, excluding resource IDs and arbitrary response text.
 * @param path - Discord API path associated with the failure.
 * @param status - HTTP status returned by Discord.
 * @param payload - Optional validated Discord error payload.
 * @returns A sanitized diagnostic message.
 */
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
