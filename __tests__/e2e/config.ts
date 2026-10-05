import type { E2EConfig } from "@tests/e2e/types.ts";

type MutableOptionalConfig = {
  -readonly [Key in "accessClientId" | "accessClientSecret"]?: string;
};

/**
 * Parse an optional Alchemy profile argument.
 * @param args - Command-line arguments.
 * @returns The selected profile, if supplied.
 */
export const parseProfile = (args: readonly string[]): string | undefined => {
  const flag = args.indexOf("--profile");
  const next = flag === -1 ? undefined : args[flag + 1];
  const equals = args.find((argument) => argument.startsWith("--profile="));
  const profile = next ?? equals?.slice("--profile=".length);
  if (flag !== -1 && (!next?.trim() || next.startsWith("--"))) {
    throw new Error("--profile requires an Alchemy profile name");
  }
  if (equals !== undefined && !profile?.trim()) {
    throw new Error("--profile requires an Alchemy profile name");
  }
  return profile;
};

/**
 * Load required E2E credentials and endpoints from the environment.
 * @param env - Process environment variables.
 * @returns Validated E2E configuration.
 */
export const configFromEnvironment = (env: NodeJS.ProcessEnv): E2EConfig => {
  const optionalConfig: MutableOptionalConfig = {};
  if (env.CF_ACCESS_CLIENT_ID) {
    optionalConfig.accessClientId = env.CF_ACCESS_CLIENT_ID;
  }
  if (env.CF_ACCESS_CLIENT_SECRET) {
    optionalConfig.accessClientSecret = env.CF_ACCESS_CLIENT_SECRET;
  }
  const config: E2EConfig = {
    adminToken: env.ADMIN_PREVIEW_TOKEN ?? "",
    guildId: env.DISCORD_GUILD_ID ?? "",
    receiverChannelId: env.DISCORD_E2E_RECEIVER_CHANNEL_ID ?? "",
    recipient: env.EMAIL_TO ?? "",
    resendKey: env.RESEND_PREVIEW_API_KEY ?? "",
    senderEmail: env.EMAIL_FROM_EMAIL ?? "",
    senderName: env.EMAIL_FROM_NAME ?? "",
    sourceChannelId: env.DISCORD_E2E_ANNOUNCEMENT_CHANNEL_ID ?? "",
    token: env.DISCORD_PREVIEW_BOT_TOKEN ?? "",
    ...optionalConfig,
  };
  const missing = Object.entries({
    ADMIN_PREVIEW_TOKEN: config.adminToken,
    DISCORD_E2E_ANNOUNCEMENT_CHANNEL_ID: config.sourceChannelId,
    DISCORD_E2E_RECEIVER_CHANNEL_ID: config.receiverChannelId,
    DISCORD_GUILD_ID: config.guildId,
    DISCORD_PREVIEW_BOT_TOKEN: config.token,
    EMAIL_FROM_EMAIL: config.senderEmail,
    EMAIL_FROM_NAME: config.senderName,
    EMAIL_TO: config.recipient,
    RESEND_PREVIEW_API_KEY: config.resendKey,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Missing required E2E configuration: ${missing.join(", ")}`
    );
  }
  return config;
};

/**
 * Reject local Alchemy profiles when the E2E target is remote.
 * @param remote - Whether E2E_MODE selects a remote worker.
 * @param profile - Optional Alchemy profile name.
 * @returns Nothing when the selected mode is valid.
 */
export const validateMode = (
  remote: boolean,
  profile: string | undefined
): void => {
  if (remote && profile) {
    throw new Error("--profile is supported only for local E2E runs");
  }
};
