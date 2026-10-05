import type { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import type { EventEmitter } from "node:events";
import process from "node:process";

import { request, waitUntil } from "@tests/e2e/http.ts";
import type { E2EConfig, LogTone } from "@tests/e2e/types.ts";

type Log = (message: string, tone?: LogTone) => void;
type ExitableChild = EventEmitter &
  Pick<ChildProcess, "exitCode" | "signalCode">;

const hasExited = (
  child: Pick<ChildProcess, "exitCode" | "signalCode">
): boolean => child.exitCode !== null || child.signalCode !== null;

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

/**
 * Wait for a child process to exit, returning false when the timeout expires.
 * @param child - Child process or compatible event emitter.
 * @param timeout - Maximum wait in milliseconds.
 * @returns Whether the child exited before the timeout.
 */
export const waitForExit = async (
  child: ExitableChild,
  timeout: number
): Promise<boolean> => {
  if (hasExited(child)) {
    return true;
  }
  const timeoutSignal = AbortSignal.timeout(timeout);
  try {
    await once(child, "exit", { signal: timeoutSignal });
    return true;
  } catch (error) {
    if (timeoutSignal.aborted) {
      return false;
    }
    throw error;
  }
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

/**
 * Stop local Alchemy and clean up its inherited streams.
 * @param dev - Local Alchemy child process.
 * @param log - Progress logger.
 * @returns Promise resolved when the process has been stopped.
 */
export const stopLocalDev = async (
  dev: ChildProcess,
  log: Log
): Promise<void> => {
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
  // Descendants can inherit streams and keep the runner alive after shutdown.
  dev.stdout?.removeAllListeners();
  dev.stderr?.removeAllListeners();
  dev.stdout?.destroy();
  dev.stderr?.destroy();
  dev.stdin?.destroy();
};

/**
 * Start local Alchemy and wait for the Worker health endpoint.
 * @param config - Credentials and Worker settings for local execution.
 * @param profile - Optional Alchemy profile.
 * @param signal - Workflow cancellation signal.
 * @param log - Progress logger.
 * @returns Child process and its local Worker URL.
 */
export const startLocalDev = async (
  config: E2EConfig,
  profile: string | undefined,
  signal: AbortSignal,
  log: Log
): Promise<{ readonly process: ChildProcess; readonly url: string }> => {
  log("Starting local Alchemy dev in the e2e-local stage...");
  const dev = spawn(
    process.execPath,
    ["run", "dev", ...(profile ? ["--profile", profile] : [])],
    {
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        ADMIN_TOKEN: config.adminToken,
        ALCHEMY_STAGE: "e2e-local",
        DISCORD_BOT_TOKEN: config.token,
        DISCORD_TARGET_CHANNEL_ID: config.receiverChannelId,
        EMAIL_FROM_EMAIL: config.senderEmail,
        EMAIL_FROM_NAME: config.senderName,
        EMAIL_TO: config.recipient,
        RESEND_API_KEY: config.resendKey,
        SOURCE_CHANNEL_ID: config.sourceChannelId,
        SOURCE_GUILD_ID: config.guildId,
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
    foundUrl ??= (text.match(/https?:\/\/localhost(?::\d+)?/gu) ?? []).at(-1);
  };
  dev.stdout?.on("data", capture);
  dev.stderr?.on("data", capture);
  dev.once("error", (error) => {
    spawnError = error;
  });
  try {
    const ready = await waitUntil(
      async (probeSignal) => {
        if (spawnError) {
          throw spawnError;
        }
        if (hasExited(dev)) {
          throw new Error(`Alchemy dev exited before ready:\n${output}`);
        }
        if (!foundUrl) {
          return { ready: false, url: "http://localhost:8787" };
        }
        try {
          const response = await request(
            `${foundUrl}/healthz`,
            { signal: probeSignal },
            signal
          );
          return { ready: response.ok, url: foundUrl };
        } catch (error) {
          if (signal.aborted) {
            throw error;
          }
          return { ready: false, url: foundUrl };
        }
      },
      (result) => result.ready,
      1000,
      120_000,
      "Timed out waiting for Alchemy dev",
      signal
    );
    log(`Local Worker is ready at ${ready.url}.`, "success");
    return { process: dev, url: ready.url };
  } catch (error) {
    await stopLocalDev(dev, log);
    if (
      error instanceof Error &&
      error.message === "Timed out waiting for Alchemy dev"
    ) {
      throw new Error(`${error.message}:\n${output}`, { cause: error });
    }
    throw error;
  }
};
