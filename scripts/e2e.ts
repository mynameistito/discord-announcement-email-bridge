import { appendFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  configFromEnvironment,
  parseProfile,
  validateMode,
} from "@tests/e2e/config.ts";
import type { E2EOptions, LogTone } from "@tests/e2e/types.ts";
import { runE2E } from "@tests/e2e/workflow.ts";
import { Effect } from "effect";

type MutableE2EOptions = {
  -readonly [Key in keyof E2EOptions]: E2EOptions[Key];
};

type ShutdownSignal = "SIGINT" | "SIGTERM";
const controller = new AbortController();
let receivedSignal: ShutdownSignal | undefined;
const log = (message: string, tone: LogTone = "info"): void => {
  const colors: Record<LogTone, number> = {
    failure: 31,
    info: 36,
    success: 32,
    warning: 33,
  };
  const renderedMessage = process.env.NO_COLOR
    ? message
    : `\u001B[${colors[tone]}m${message}\u001B[0m`;
  console.log(renderedMessage);

  const runnerTemp = process.env.RUNNER_TEMP;
  if (runnerTemp) {
    const logPath = path.join(runnerTemp, "e2e.log");
    try {
      appendFileSync(logPath, `${message}\n`, "utf-8");
    } catch {
      // Log capture is best-effort and must not affect the E2E outcome.
    }
  }
};
const requestShutdown = (signal: ShutdownSignal): void => {
  if (controller.signal.aborted) {
    return;
  }
  receivedSignal = signal;
  log(`Received ${signal}; shutting down...`, "warning");
  controller.abort(new Error(`E2E run interrupted by ${signal}`));
};
const handleSigint = (): void => requestShutdown("SIGINT");
const handleSigterm = (): void => requestShutdown("SIGTERM");
process.once("SIGINT", handleSigint);
process.once("SIGTERM", handleSigterm);

let exitCode = 0;
try {
  const profile = parseProfile(process.argv.slice(2));
  const remote = process.env.E2E_MODE === "remote";
  validateMode(remote, profile);
  const config = configFromEnvironment(process.env);
  const options: MutableE2EOptions = {
    config,
    log,
    remote,
    signal: controller.signal,
  };
  if (process.env.E2E_WORKER_URL) {
    options.workerUrl = process.env.E2E_WORKER_URL;
  }
  if (profile) {
    options.profile = profile;
  }
  await Effect.runPromise(runE2E(options));
} catch (error) {
  if (controller.signal.aborted) {
    log(
      `E2E interrupted by ${receivedSignal ?? "shutdown request"}.`,
      "warning"
    );
    exitCode = receivedSignal === "SIGTERM" ? 143 : 130;
  } else {
    log(
      `E2E failed: ${error instanceof Error ? error.message : "Unexpected E2E failure."}`,
      "failure"
    );
    exitCode = 1;
  }
} finally {
  process.off("SIGINT", handleSigint);
  process.off("SIGTERM", handleSigterm);
}

let exitTone: LogTone = "failure";
if (exitCode === 0) {
  exitTone = "success";
} else if (exitCode === 130 || exitCode === 143) {
  exitTone = "warning";
}
log(`E2E script exiting with code ${exitCode}.`, exitTone);
// All deliberate cleanup has completed; avoid lingering runtime handles.
process.exit(exitCode);
