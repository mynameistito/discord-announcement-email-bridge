import { Effect } from "effect";

import {
  crosspostAnnouncement,
  createAnnouncement,
  verifyDiscord,
} from "./discord.ts";
import { startLocalDev, stopLocalDev } from "./local-worker.ts";
import { photoAttachment } from "./photo-fixture.ts";
import { announcementContent } from "./types.ts";
import type { E2EOptions, LogTone } from "./types.ts";
import {
  pollBridge,
  seedCursor,
  waitForDelivery,
  waitForWorkerReady,
} from "./worker.ts";

const defaultLog = (message: string, tone: LogTone = "info"): void => {
  const colors: Record<LogTone, number> = {
    failure: 31,
    info: 36,
    success: 32,
    warning: 33,
  };
  console.log(
    process.env.NO_COLOR
      ? message
      : `\u001B[${colors[tone]}m${message}\u001B[0m`
  );
};

export const runE2E = (options: E2EOptions): Effect.Effect<void, Error> =>
  Effect.gen(function* runE2EEffect() {
    const { config, signal } = options;
    const log = options.log ?? defaultLog;
    let workerUrl = options.workerUrl;
    let devProcess:
      | Awaited<ReturnType<typeof startLocalDev>>["process"]
      | undefined;
    try {
      if (options.remote) {
        const remoteUrl = workerUrl;
        if (!remoteUrl)
          throw new Error("E2E_WORKER_URL is required when E2E_MODE=remote");
        yield* Effect.promise(() =>
          waitForWorkerReady(remoteUrl, config, signal)
        );
      } else {
        const local = yield* Effect.promise(() =>
          startLocalDev(config, options.profile, signal, log)
        );
        workerUrl = local.url;
        devProcess = local.process;
      }

      const targetUrl = workerUrl;
      if (!targetUrl) throw new Error("Worker URL was not configured");
      log(
        "Checking Discord channel configuration and follower subscription..."
      );
      yield* Effect.promise(() => verifyDiscord(config, signal, log));
      log("Seeding the bridge cursor before publishing the test post...");
      yield* Effect.promise(() => seedCursor(targetUrl, config, signal));

      const marker = `E2E ${crypto.randomUUID()}`;
      const attachment = options.attachment ?? (yield* photoAttachment);
      const messageId = yield* Effect.promise(() =>
        createAnnouncement(
          config,
          marker,
          announcementContent(marker),
          signal,
          attachment
        )
      );
      log(`Created test announcement ${messageId}.`, "success");
      const followerCopyId = yield* Effect.promise(() =>
        crosspostAnnouncement(config, messageId, signal, log)
      );
      log("Follower copy appeared in the receiver channel.", "success");
      log("Polling the bridge for the test crosspost...");
      yield* Effect.promise(() => pollBridge(targetUrl, config, signal));
      yield* Effect.promise(() =>
        waitForDelivery(targetUrl, config, followerCopyId, signal, log)
      );
      log(
        `E2E passed. Discord message ${messageId}; Worker recorded a successful Resend delivery.`,
        "success"
      );
    } finally {
      const localProcess = devProcess;
      if (localProcess) {
        yield* Effect.promise(() => stopLocalDev(localProcess, log));
        log("Stopped local Alchemy dev.", "success");
      }
    }
  });
