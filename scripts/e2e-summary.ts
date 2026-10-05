import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import type { E2ESummaryInput } from "@scripts/e2e-summary-content.ts";
import { renderE2ESummary } from "@scripts/e2e-summary-content.ts";

const requiredEnvironment = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required E2E summary environment variable: ${name}`
    );
  }
  return value;
};

const readE2ELog = async (filePath: string): Promise<string> => {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return "";
  }
};

const input: E2ESummaryInput = {
  deployOutcome: process.env.DEPLOY_OUTCOME ?? "unknown",
  destroyOutcome: process.env.DESTROY_OUTCOME ?? "unknown",
  e2eLog: await readE2ELog(
    path.join(requiredEnvironment("RUNNER_TEMP"), "e2e.log")
  ),
  e2eOutcome: process.env.E2E_OUTCOME ?? "unknown",
  installOutcome: process.env.INSTALL_OUTCOME ?? "unknown",
  jobStatus: process.env.JOB_STATUS ?? "unknown",
  opOutcome: process.env.OP_OUTCOME ?? "unknown",
  runUrl: requiredEnvironment("RUN_URL"),
  stage: requiredEnvironment("ALCHEMY_STAGE"),
  workerUrl: requiredEnvironment("E2E_WORKER_URL"),
};

await appendFile(
  requiredEnvironment("GITHUB_STEP_SUMMARY"),
  renderE2ESummary(input),
  "utf-8"
);
