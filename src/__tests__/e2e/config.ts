import type { E2EConfig } from "./types.ts";

export const parseProfile = (args: readonly string[]): string | undefined => {
  const flag = args.indexOf("--profile");
  const next = flag === -1 ? undefined : args[flag + 1];
  const equals = args.find((argument) => argument.startsWith("--profile="));
  const profile = next ?? equals?.slice("--profile=".length);
  if (flag !== -1 && (!next || next.startsWith("--"))) {
    throw new Error("--profile requires an Alchemy profile name");
  }
  return profile;
};

export const configFromEnvironment = (env: NodeJS.ProcessEnv): E2EConfig => {
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
    ...(env.CF_ACCESS_CLIENT_ID
      ? { accessClientId: env.CF_ACCESS_CLIENT_ID }
      : {}),
    ...(env.CF_ACCESS_CLIENT_SECRET
      ? { accessClientSecret: env.CF_ACCESS_CLIENT_SECRET }
      : {}),
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
  if (missing.length > 0)
    throw new Error(
      `Missing required E2E configuration: ${missing.join(", ")}`
    );
  return config;
};

export const validateMode = (
  remote: boolean,
  profile: string | undefined
): void => {
  if (remote && profile)
    throw new Error("--profile is supported only for local E2E runs");
};
