import { Effect } from "effect";

import {
  configFromEnvironment,
  parseProfile,
  validateMode,
} from "../src/__tests__/e2e/config.ts";
import type { LogTone } from "../src/__tests__/e2e/types.ts";
import { runE2E } from "../src/__tests__/e2e/workflow.ts";

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
  console.log(
    process.env.NO_COLOR
      ? message
      : `\u001B[${colors[tone]}m${message}\u001B[0m`
  );
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
  const options: {
    config: typeof config;
    log: typeof log;
    profile?: string;
    remote: boolean;
    signal: AbortSignal;
    workerUrl?: string;
  } = { config, log, remote, signal: controller.signal };
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
