import { setTimeout as pause } from "node:timers/promises";

import { Schema } from "effect";

const DiscordErrorSchema = Schema.Struct({ code: Schema.Number });
export const discordApi = "https://discord.com/api/v10";

export class CloudflareAccessRedirectError extends Error {
  readonly _tag = "CloudflareAccessRedirectError" as const;

  constructor(label: string) {
    super(
      `${label} failed because Cloudflare Access redirected the request to its login page. Verify the service token is valid and allowed by a Service Auth policy.`
    );
    this.name = "CloudflareAccessRedirectError";
  }
}

export const isCloudflareAccessRedirect = (response: Response): boolean =>
  response.status >= 300 &&
  response.status < 400 &&
  response.headers.get("location")?.includes("/cdn-cgi/access/login") === true;

export const request = (
  input: string | URL | Request,
  init: RequestInit,
  defaultSignal: AbortSignal
): Promise<Response> =>
  fetch(input, { ...init, signal: init.signal ?? defaultSignal });

const discordErrorCode = async (
  response: Response
): Promise<number | undefined> => {
  try {
    const parsed = Schema.decodeUnknownOption(DiscordErrorSchema)(
      await response.json()
    );
    return parsed._tag === "Some" ? parsed.value.code : undefined;
  } catch {
    return undefined;
  }
};

const permissionHint = (label: string, code?: number): string => {
  if (code === 10_003)
    return "Discord could not find that channel ID; verify the E2E channel field in 1Password.";
  if (code === 50_001)
    return "Discord reports Missing Access. Verify the preview bot is installed in the guild and has VIEW_CHANNEL.";
  if (code === 50_013)
    return "Discord reports Missing Permissions. Check the preview bot's permissions and channel overrides.";
  if (label === "Read source channel")
    return "The preview bot must be installed in the source guild and have VIEW_CHANNEL in the source channel.";
  if (label === "List receiver-channel webhooks")
    return "The preview bot needs MANAGE_WEBHOOKS in the receiver channel.";
  return "Check that the preview bot can access this channel and has the required permissions.";
};

export const jsonRequest = async <T>(
  url: string,
  init: RequestInit,
  label: string,
  signal: AbortSignal
): Promise<T> => {
  const response = await request(url, init, signal);
  if (isCloudflareAccessRedirect(response))
    throw new CloudflareAccessRedirectError(label);
  if (!response.ok) {
    const isDiscordRequest = response.url.startsWith(discordApi);
    const code = isDiscordRequest
      ? await discordErrorCode(response)
      : undefined;
    const detail = code === undefined ? "" : ` (Discord code ${code})`;
    if (response.status === 401 && isDiscordRequest) {
      throw new Error(
        `Discord rejected preview bot authentication (HTTP 401)${detail}. Check DISCORD_PREVIEW_BOT_TOKEN in 1Password.`
      );
    }
    if (response.status === 403)
      throw new Error(
        `${label} failed (HTTP 403)${detail}. ${permissionHint(label, code)}`
      );
    throw new Error(`${label} failed (HTTP ${response.status})${detail}`);
  }
  // SAFETY: Every caller binds T to the documented endpoint response.
  return (await response.json()) as T;
};

export const waitUntil = async <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  isComplete: (value: T) => boolean,
  interval: number,
  timeout: number,
  failureMessage: string,
  shutdownSignal: AbortSignal
): Promise<T> => {
  const deadline = performance.now() + timeout;
  while (true) {
    shutdownSignal.throwIfAborted();
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error(failureMessage);
    const timeoutSignal = AbortSignal.timeout(remaining);
    const signal = AbortSignal.any([shutdownSignal, timeoutSignal]);
    let result: T;
    try {
      result = await operation(signal);
    } catch (error) {
      if (timeoutSignal.aborted && !shutdownSignal.aborted)
        throw new Error(failureMessage, { cause: error });
      throw error;
    }
    if (isComplete(result)) return result;
    await pause(Math.min(interval, remaining), undefined, {
      signal: shutdownSignal,
    });
  }
};
