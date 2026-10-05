import {
  crosspostAnnouncement,
  createAnnouncement,
  verifyDiscord,
} from "@tests/e2e/discord.ts";
import { startLocalDev, stopLocalDev } from "@tests/e2e/local-worker.ts";
import { photoAttachment } from "@tests/e2e/photo-fixture.ts";
import { announcementContent } from "@tests/e2e/types.ts";
import type { E2EOptions, LogTone } from "@tests/e2e/types.ts";
import {
  pollBridge,
  seedCursor,
  waitForDelivery,
  waitForWorkerReady,
} from "@tests/e2e/worker.ts";
import { Effect, Exit } from "effect";

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

const attempt = <A>(operation: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({
    catch: (cause) =>
      cause instanceof Error ? cause : new Error(String(cause)),
    try: operation,
  });

const stopLocalDevEffect = (
  local: Awaited<ReturnType<typeof startLocalDev>>,
  log: (message: string, tone?: LogTone) => void
): Effect.Effect<void, Error> =>
  attempt(() => stopLocalDev(local.process, log)).pipe(
    Effect.tap(() =>
      Effect.sync(() => log("Stopped local Alchemy dev.", "success"))
    )
  );

const releaseLocalDev = <A, E>(
  local: Awaited<ReturnType<typeof startLocalDev>>,
  exit: Exit.Exit<A, E>,
  log: (message: string, tone?: LogTone) => void
): Effect.Effect<void, Error> =>
  stopLocalDevEffect(local, log).pipe(
    Effect.catch((cleanupError) => {
      if (!Exit.isFailure(exit)) {
        return Effect.fail(cleanupError);
      }
      return Effect.sync(() =>
        log(
          `Local Alchemy cleanup failed after the workflow failed: ${cleanupError.message}`,
          "warning"
        )
      );
    })
  );

const runAnnouncement = (
  options: E2EOptions,
  attachment: NonNullable<E2EOptions["attachment"]>,
  log: (message: string, tone?: LogTone) => void,
  workerUrl: string
): Effect.Effect<void, Error> =>
  Effect.gen(function* runAnnouncementEffect() {
    const { config, signal } = options;
    log("Checking Discord channel configuration and follower subscription...");
    yield* attempt(() => verifyDiscord(config, signal, log));
    log("Seeding the bridge cursor before publishing the test post...");
    yield* attempt(() => seedCursor(workerUrl, config, signal));

    const marker = `E2E ${crypto.randomUUID()}`;
    const messageId = yield* attempt(() =>
      createAnnouncement(
        config,
        marker,
        announcementContent(marker),
        signal,
        attachment
      )
    );
    log(`Created test announcement ${messageId}.`, "success");
    const expectedFilename =
      attachment.kind === "bytes"
        ? attachment.filename
        : (attachment.filename ?? attachment.path.split(/[\\/]/u).at(-1));
    const followerCopyId = yield* attempt(() =>
      crosspostAnnouncement(config, messageId, signal, log, expectedFilename)
    );
    log("Follower copy appeared in the receiver channel.", "success");
    log("Polling the bridge for the test crosspost...");
    yield* attempt(() => pollBridge(workerUrl, config, signal));
    yield* attempt(() =>
      waitForDelivery(workerUrl, config, followerCopyId, signal, log)
    );
    log(
      `E2E passed. Discord message ${messageId}; Worker recorded a successful Resend delivery.`,
      "success"
    );
  });

/**
 * Run the end-to-end Discord-to-email workflow.
 * @param options - Credentials, target mode, cancellation, and output options.
 * @returns Effect that completes after the test delivery or fails with an error.
 */
export const runE2E = (options: E2EOptions): Effect.Effect<void, Error> =>
  Effect.gen(function* runE2EEffect() {
    const { config, signal } = options;
    const log = options.log ?? defaultLog;
    const attachment = options.attachment ?? (yield* photoAttachment);

    if (options.remote) {
      const remoteUrl = options.workerUrl;
      if (!remoteUrl) {
        return yield* Effect.fail(
          new Error("E2E_WORKER_URL is required when E2E_MODE=remote")
        );
      }
      yield* attempt(() => waitForWorkerReady(remoteUrl, config, signal));
      return yield* runAnnouncement(options, attachment, log, remoteUrl);
    }

    return yield* Effect.acquireUseRelease(
      attempt(() => startLocalDev(config, options.profile, signal, log)),
      (local) => runAnnouncement(options, attachment, log, local.url),
      (local, exit) => releaseLocalDev(local, exit, log)
    );
  });
