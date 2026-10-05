import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setTimeout as pause } from "node:timers/promises";

import { Schema } from "effect";

interface DiscordChannel {
  readonly guild_id: string;
  readonly type: number;
}

interface DiscordCurrentUser {
  readonly bot?: boolean;
}

interface DiscordWebhook {
  readonly type: number;
  readonly source_guild?: { readonly id: string } | null;
  readonly source_channel?: { readonly id: string } | null;
}

interface DiscordMessage {
  readonly id?: string;
  readonly message_reference?: { readonly message_id?: string } | null;
}

interface WorkerStatus {
  readonly sentDeliveries: number;
  readonly failedDeliveries: number;
  readonly targetSentDeliveries?: number;
  readonly targetFailedDeliveries?: number;
}

type LogTone = "info" | "success" | "warning" | "failure";
type ShutdownSignal = "SIGINT" | "SIGTERM";
type HeadersInput = NonNullable<RequestInit["headers"]>;

const DiscordErrorSchema = Schema.Struct({
  code: Schema.Number,
});

const discordApi = "https://discord.com/api/v10";
const localWorkerUrl = process.env.E2E_WORKER_URL ?? "http://localhost:8787";
const isRemote = process.env.E2E_MODE === "remote";

const scriptArguments: readonly string[] = process.argv.slice(2);
const profileFlag = scriptArguments.indexOf("--profile");

const profileArgument =
  profileFlag === -1 ? undefined : scriptArguments[profileFlag + 1];

const profileEqualsArgument = scriptArguments.find((argument) =>
  argument.startsWith("--profile=")
);

const profile =
  profileArgument ?? profileEqualsArgument?.slice("--profile=".length);

const token = process.env.DISCORD_PREVIEW_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;
const sourceChannelId = process.env.DISCORD_E2E_ANNOUNCEMENT_CHANNEL_ID;
const receiverChannelId = process.env.DISCORD_E2E_RECEIVER_CHANNEL_ID;
const recipient = process.env.EMAIL_TO;
const resendKey = process.env.RESEND_PREVIEW_API_KEY;
const senderName = process.env.EMAIL_FROM_NAME;
const senderEmail = process.env.EMAIL_FROM_EMAIL;
const adminToken = process.env.ADMIN_PREVIEW_TOKEN;

const required = {
  ADMIN_PREVIEW_TOKEN: adminToken,
  DISCORD_E2E_ANNOUNCEMENT_CHANNEL_ID: sourceChannelId,
  DISCORD_E2E_RECEIVER_CHANNEL_ID: receiverChannelId,
  DISCORD_GUILD_ID: guildId,
  DISCORD_PREVIEW_BOT_TOKEN: token,
  EMAIL_FROM_EMAIL: senderEmail,
  EMAIL_FROM_NAME: senderName,
  EMAIL_TO: recipient,
  RESEND_PREVIEW_API_KEY: resendKey,
};

const log = (message: string, tone: LogTone = "info"): void => {
  const codes: Record<LogTone, number> = {
    failure: 31,
    info: 36,
    success: 32,
    warning: 33,
  };

  const colored = process.env.NO_COLOR
    ? message
    : `\u001B[${codes[tone]}m${message}\u001B[0m`;

  console.log(colored);
};

const shutdownController = new AbortController();
const shutdownSignal = shutdownController.signal;

let receivedSignal: ShutdownSignal | undefined;

const requestShutdown = (signal: ShutdownSignal): void => {
  if (shutdownSignal.aborted) {
    return;
  }

  receivedSignal = signal;

  log(`Received ${signal}; shutting down...`, "warning");

  shutdownController.abort(new Error(`E2E run interrupted by ${signal}`));
};

const handleSigint = (): void => {
  requestShutdown("SIGINT");
};

const handleSigterm = (): void => {
  requestShutdown("SIGTERM");
};

process.once("SIGINT", handleSigint);
process.once("SIGTERM", handleSigterm);

const validateConfiguration = (): void => {
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required E2E configuration: ${missing.join(", ")}`
    );
  }

  if (
    profileFlag !== -1 &&
    (!profileArgument || profileArgument.startsWith("--"))
  ) {
    throw new Error("--profile requires an Alchemy profile name");
  }

  if (isRemote && profile) {
    throw new Error("--profile is supported only for local E2E runs");
  }
};

const request = (
  input: string | URL | Request,
  init: RequestInit = {}
): Promise<Response> =>
  fetch(input, {
    ...init,
    signal: init.signal ?? shutdownSignal,
  });

class CloudflareAccessRedirectError extends Error {
  readonly _tag = "CloudflareAccessRedirectError" as const;

  constructor(label: string) {
    super(
      `${label} failed because Cloudflare Access redirected the request to its login page. Verify the service token is valid and allowed by a Service Auth policy.`
    );
    this.name = "CloudflareAccessRedirectError";
  }
}

const isCloudflareAccessRedirect = (response: Response): boolean => {
  const location = response.headers.get("location");

  return (
    response.status >= 300 &&
    response.status < 400 &&
    location?.includes("/cdn-cgi/access/login") === true
  );
};

const cloudflareAccessError = (label: string): Error =>
  new CloudflareAccessRedirectError(label);

const waitUntil = <T>(
  operation: (signal: AbortSignal) => Promise<T>,
  isComplete: (value: T) => boolean,
  interval: number,
  timeout: number,
  failureMessage: string
): Promise<T> => {
  const deadline = performance.now() + timeout;

  const poll = async (): Promise<T> => {
    shutdownSignal.throwIfAborted();

    const remaining = deadline - performance.now();

    if (remaining <= 0) {
      throw new Error(failureMessage);
    }

    const timeoutSignal = AbortSignal.timeout(remaining);
    const signal = AbortSignal.any([shutdownSignal, timeoutSignal]);
    let result: T;

    try {
      result = await operation(signal);
    } catch (error) {
      if (timeoutSignal.aborted && !shutdownSignal.aborted) {
        throw new Error(failureMessage, { cause: error });
      }

      throw error;
    }

    if (isComplete(result)) {
      return result;
    }

    await pause(Math.min(interval, remaining), undefined, {
      signal: shutdownSignal,
    });

    return poll();
  };

  return poll();
};

const permissionHint = (
  operation: string,
  discordCode: number | undefined
): string => {
  if (discordCode === 10_003) {
    return "Discord could not find that channel ID; verify the E2E channel field in 1Password.";
  }

  if (discordCode === 50_001) {
    return "Discord reports Missing Access. Verify this preview bot token belongs to a bot installed in the channel's guild, and check channel-specific VIEW_CHANNEL overrides.";
  }

  if (discordCode === 50_013) {
    return "Discord reports Missing Permissions. Check the preview bot's permissions and channel-specific overrides.";
  }

  if (operation === "Read source channel") {
    return "The preview bot must be installed in the source guild and have VIEW_CHANNEL in the source channel.";
  }

  if (operation === "List receiver-channel webhooks") {
    return "The preview bot needs MANAGE_WEBHOOKS in the receiver channel.";
  }

  return "Check that the preview bot can access this channel and has the required permissions.";
};

const discordErrorCode = async (
  response: Response
): Promise<number | undefined> => {
  try {
    const payload: unknown = await response.json();

    const parsed = Schema.decodeUnknownOption(DiscordErrorSchema)(payload);

    return parsed._tag === "Some" ? parsed.value.code : undefined;
  } catch {
    return undefined;
  }
};

const jsonRequest = async <T>(
  url: string,
  init: RequestInit,
  label: string
): Promise<T> => {
  const response = await request(url, init);

  if (isCloudflareAccessRedirect(response)) {
    throw cloudflareAccessError(label);
  }

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

    if (response.status === 403) {
      throw new Error(
        `${label} failed (HTTP 403)${detail}. ${permissionHint(label, code)}`
      );
    }

    throw new Error(`${label} failed (HTTP ${response.status})${detail}`);
  }

  // SAFETY: Each caller selects T from the documented Discord
  // or Worker endpoint response.
  return (await response.json()) as T;
};

const discordHeaders: HeadersInput = {
  Authorization: `Bot ${token}`,
  "Content-Type": "application/json",
};

const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

const hasRunningProcessGroup = (child: ChildProcess): boolean => {
  if (process.platform === "win32" || !child.pid) {
    return false;
  }

  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const waitForExit = async (
  child: ChildProcess,
  timeout: number
): Promise<boolean> => {
  if (hasExited(child)) {
    return true;
  }

  try {
    await once(child, "exit", { signal: AbortSignal.timeout(timeout) });
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return false;
    }

    throw error;
  }
};

const releaseChildStreams = (child: ChildProcess): void => {
  child.stdout?.removeAllListeners();
  child.stderr?.removeAllListeners();

  child.stdout?.destroy();
  child.stderr?.destroy();
  child.stdin?.destroy();
};

const signalProcessTree = async (
  child: ChildProcess,
  signal: NodeJS.Signals
): Promise<void> => {
  if (process.platform === "win32") {
    if (!child.pid) {
      return;
    }

    const args = ["/PID", String(child.pid), "/T"];

    if (signal === "SIGKILL") {
      args.push("/F");
    }

    const taskkillPath = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    const taskkill = spawn(taskkillPath, args, {
      stdio: "ignore",
      windowsHide: true,
    });

    await once(taskkill, "exit");
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to signaling the direct child if its process group is gone.
    }
  }

  child.kill(signal);
};

const stopLocalDev = async (dev: ChildProcess): Promise<void> => {
  log("Stopping local Alchemy dev...");

  await signalProcessTree(dev, "SIGTERM");

  const exitedGracefully = await waitForExit(dev, 3000);

  if ((!exitedGracefully && !hasExited(dev)) || hasRunningProcessGroup(dev)) {
    log(
      "Local Alchemy dev did not stop after SIGTERM; forcing shutdown...",
      "warning"
    );

    await signalProcessTree(dev, "SIGKILL");

    await waitForExit(dev, 2000);
  }

  /*
   * A descendant process can inherit these handles and keep them
   * open after the direct child exits. The E2E runner does not
   * need them once shutdown begins.
   */
  releaseChildStreams(dev);
};

const verifyDiscordBotToken = async (): Promise<void> => {
  const currentUser = await jsonRequest<DiscordCurrentUser>(
    `${discordApi}/users/@me`,
    {
      headers: discordHeaders,
    },
    "Authenticate preview bot"
  );

  if (currentUser.bot !== true) {
    throw new Error(
      "DISCORD_PREVIEW_BOT_TOKEN did not authenticate a Discord bot account."
    );
  }

  log("Authenticated the Discord preview bot.", "success");
};

const startLocalDev = async (
  profileName: string | undefined
): Promise<{
  readonly process: ChildProcess;
  readonly url: string;
}> => {
  log("Starting local Alchemy dev in the e2e-local stage...");

  const dev = spawn(
    process.execPath,
    ["run", "dev", ...(profileName ? ["--profile", profileName] : [])],
    {
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ADMIN_TOKEN: adminToken,
        ALCHEMY_STAGE: "e2e-local",
        DISCORD_BOT_TOKEN: token,
        DISCORD_TARGET_CHANNEL_ID: receiverChannelId,
        EMAIL_FROM_EMAIL: senderEmail,
        EMAIL_FROM_NAME: senderName,
        EMAIL_TO: recipient,
        RESEND_API_KEY: resendKey,
        SOURCE_CHANNEL_ID: sourceChannelId,
        SOURCE_GUILD_ID: guildId,
        STAGE: "e2e-local",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  let output = "";
  let foundUrl: string | undefined;
  let spawnError: Error | undefined;

  const capture = (chunk: Buffer): void => {
    const text = chunk.toString();

    output = `${output}${text}`.slice(-12_000);

    const urls = text.match(/https?:\/\/localhost(?::\d+)?/gu) ?? [];

    foundUrl ??= urls.at(-1);
  };

  dev.stdout?.on("data", capture);
  dev.stderr?.on("data", capture);

  dev.once("error", (error) => {
    spawnError = error;
  });

  try {
    const ready = await waitUntil(
      async (signal) => {
        if (spawnError) {
          throw spawnError;
        }

        if (hasExited(dev)) {
          throw new Error(`Alchemy dev exited before ready:\n${output}`);
        }

        const url = foundUrl;

        if (!url) {
          return {
            ready: false,
            url: localWorkerUrl,
          };
        }

        try {
          const response = await request(`${url}/healthz`, { signal });

          return {
            ready: response.ok,
            url,
          };
        } catch (error) {
          if (shutdownSignal.aborted) {
            throw error;
          }

          return {
            ready: false,
            url,
          };
        }
      },
      (result) => result.ready,
      1000,
      120_000,
      `Timed out waiting for Alchemy dev:\n${output}`
    );

    log(`Local Worker is ready at ${ready.url}.`, "success");

    return {
      process: dev,
      url: ready.url,
    };
  } catch (error) {
    await stopLocalDev(dev);
    throw error;
  }
};

const checkFollow = async (): Promise<void> => {
  const webhooks = await jsonRequest<readonly DiscordWebhook[]>(
    `${discordApi}/channels/${receiverChannelId}/webhooks`,
    {
      headers: discordHeaders,
    },
    "List receiver-channel webhooks"
  );

  const followsSource = webhooks.some(
    (webhook) =>
      webhook.type === 2 &&
      webhook.source_guild?.id === guildId &&
      webhook.source_channel?.id === sourceChannelId
  );

  if (!followsSource) {
    throw new Error(
      "E2E receiver channel is not following the configured source announcement channel"
    );
  }
};

const assertChannels = async (): Promise<void> => {
  const [source, receiver] = await Promise.all([
    jsonRequest<DiscordChannel>(
      `${discordApi}/channels/${sourceChannelId}`,
      {
        headers: discordHeaders,
      },
      "Read source channel"
    ),
    jsonRequest<DiscordChannel>(
      `${discordApi}/channels/${receiverChannelId}`,
      {
        headers: discordHeaders,
      },
      "Read receiver channel"
    ),
  ]);

  if (source.guild_id !== guildId || source.type !== 5) {
    throw new Error(
      "Configured source channel is not an Announcement Channel in DISCORD_GUILD_ID"
    );
  }

  if (receiver.guild_id !== guildId) {
    throw new Error("Configured receiver channel is not in DISCORD_GUILD_ID");
  }
};

const waitForCrosspost = async (messageId: string): Promise<string> => {
  const receiverMessages = await waitUntil(
    (signal) =>
      jsonRequest<readonly DiscordMessage[]>(
        `${discordApi}/channels/${receiverChannelId}/messages?limit=100`,
        {
          headers: discordHeaders,
          signal,
        },
        "Read receiver messages"
      ),
    (messages) =>
      messages.some(
        (message) => message.message_reference?.message_id === messageId
      ),
    2000,
    60_000,
    "Discord did not create the follower crosspost within 60 seconds"
  );

  const followerCopy = receiverMessages.find(
    (message) => message.message_reference?.message_id === messageId
  );

  if (!followerCopy?.id) {
    throw new Error("Discord follower copy did not include a message ID");
  }

  return followerCopy.id;
};

const deliveryStatus = async (
  workerUrl: string,
  headers: HeadersInput,
  signal?: AbortSignal,
  discordMessageId?: string
): Promise<WorkerStatus> => {
  const statusUrl = new URL(`${workerUrl}/admin/status`);

  if (discordMessageId) {
    statusUrl.searchParams.set("discordMessageId", discordMessageId);
  }

  const statusInit: RequestInit = { headers, redirect: "manual" };

  if (signal) {
    statusInit.signal = signal;
  }

  const response = await jsonRequest<WorkerStatus>(
    statusUrl.toString(),
    statusInit,
    "Read Worker delivery status"
  );

  if (
    !Number.isSafeInteger(response.sentDeliveries) ||
    !Number.isSafeInteger(response.failedDeliveries)
  ) {
    throw new TypeError(
      "Worker status response contains invalid delivery counts"
    );
  }

  return response;
};

const waitForDelivery = async (
  workerUrl: string,
  headers: HeadersInput,
  discordMessageId: string
): Promise<void> => {
  await waitUntil(
    async (signal) => {
      const status = await deliveryStatus(
        workerUrl,
        headers,
        signal,
        discordMessageId
      );

      if ((status.targetFailedDeliveries ?? 0) > 0) {
        throw new Error("Worker recorded a failed email delivery");
      }

      return status;
    },
    (status) => (status.targetSentDeliveries ?? 0) > 0,
    5000,
    180_000,
    "Worker did not record a successful email delivery within 180 seconds"
  );
};

const waitForWorkerReady = async (workerUrl: string): Promise<void> => {
  let base = workerUrl;

  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }
  const healthHeaders = new Headers();
  const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
  const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;

  if (accessClientId && accessClientSecret) {
    healthHeaders.set("CF-Access-Client-Id", accessClientId);
    healthHeaders.set("CF-Access-Client-Secret", accessClientSecret);
  }

  await waitUntil(
    async (signal) => {
      try {
        const response = await request(`${base}/healthz`, {
          headers: healthHeaders,
          redirect: "manual",
          signal,
        });

        if (isCloudflareAccessRedirect(response)) {
          throw cloudflareAccessError("Worker health check");
        }

        return response.ok;
      } catch (error) {
        if (
          shutdownSignal.aborted ||
          error instanceof CloudflareAccessRedirectError
        ) {
          throw error;
        }

        return false;
      }
    },
    Boolean,
    1000,
    60_000,
    "Worker did not become healthy within 60 seconds"
  );
};

const run = async (workerUrl: string): Promise<void> => {
  const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
  const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;

  let base = workerUrl;

  while (base.endsWith("/")) {
    base = base.slice(0, -1);
  }

  const adminHeaders = new Headers({
    Authorization: `Bearer ${adminToken}`,
  });

  if (accessClientId && accessClientSecret) {
    adminHeaders.set("CF-Access-Client-Id", accessClientId);
    adminHeaders.set("CF-Access-Client-Secret", accessClientSecret);
  }

  log("Checking Discord channel configuration and follower subscription...");

  await verifyDiscordBotToken();
  await assertChannels();
  await checkFollow();

  log(
    "Receiver channel is following the configured source channel.",
    "success"
  );

  log("Seeding the bridge cursor before publishing the test post...");

  const baseline = await request(`${base}/admin/poll`, {
    headers: adminHeaders,
    method: "POST",
    redirect: "manual",
  });

  if (isCloudflareAccessRedirect(baseline)) {
    throw cloudflareAccessError("Baseline Worker poll");
  }

  if (baseline.status !== 202) {
    throw new Error(`Baseline Worker poll failed (HTTP ${baseline.status})`);
  }

  const marker = `E2E ${crypto.randomUUID()}`;

  const created = await jsonRequest<{
    readonly id?: string;
  }>(
    `${discordApi}/channels/${sourceChannelId}/messages`,
    {
      body: JSON.stringify({
        content: marker,
      }),
      headers: discordHeaders,
      method: "POST",
    },
    "Create E2E announcement"
  );

  if (!created.id) {
    throw new Error("Discord did not return an announcement message ID");
  }

  log(`Created test announcement ${created.id}.`, "success");

  await jsonRequest<DiscordMessage>(
    `${discordApi}/channels/${sourceChannelId}/messages/${created.id}/crosspost`,
    {
      headers: discordHeaders,
      method: "POST",
    },
    "Crosspost E2E announcement"
  );

  log("Crossposted announcement; waiting for the follower copy...");

  const followerCopyId = await waitForCrosspost(created.id);

  log("Follower copy appeared in the receiver channel.", "success");

  log("Polling the bridge for the test crosspost...");

  const poll = await request(`${base}/admin/poll`, {
    headers: adminHeaders,
    method: "POST",
    redirect: "manual",
  });

  if (isCloudflareAccessRedirect(poll)) {
    throw cloudflareAccessError("Worker poll");
  }

  if (poll.status !== 202) {
    throw new Error(`Worker poll failed (HTTP ${poll.status})`);
  }

  log("Poll accepted; waiting for the queued email delivery...");

  await waitForDelivery(base, adminHeaders, followerCopyId);

  log(
    `E2E passed. Discord message ${created.id}; Worker recorded a successful Resend delivery.`,
    "success"
  );
};

const main = async (): Promise<number> => {
  let devProcess: ChildProcess | undefined;

  try {
    validateConfiguration();

    if (isRemote) {
      const url = process.env.E2E_WORKER_URL;

      if (!url) {
        throw new Error("E2E_WORKER_URL is required when E2E_MODE=remote");
      }

      await waitForWorkerReady(url);
      await run(url);
    } else {
      const local = await startLocalDev(profile);

      devProcess = local.process;

      await run(local.url);
    }

    return 0;
  } catch (error) {
    if (shutdownSignal.aborted) {
      const signal = receivedSignal ?? "shutdown request";

      log(`E2E interrupted by ${signal}.`, "warning");

      return receivedSignal === "SIGTERM" ? 143 : 130;
    }

    const message =
      error instanceof Error ? error.message : "Unexpected E2E failure.";

    log(`E2E failed: ${message}`, "failure");

    return 1;
  } finally {
    if (devProcess) {
      await stopLocalDev(devProcess);

      log("Stopped local Alchemy dev.", "success");
    }
  }
};

const exitCode = await main();

process.off("SIGINT", handleSigint);
process.off("SIGTERM", handleSigterm);

let exitTone: LogTone;

if (exitCode === 0) {
  exitTone = "success";
} else if (exitCode === 130 || exitCode === 143) {
  exitTone = "warning";
} else {
  exitTone = "failure";
}

log(`E2E script exiting with code ${exitCode}.`, exitTone);

/*
 * All deliberate cleanup has completed at this point.
 *
 * Explicitly terminate the E2E runner so an unexpected active
 * handle from Bun, fetch, Alchemy, Wrangler, or a child stdio
 * pipe cannot leave the command running indefinitely.
 */
process.exit(exitCode);
