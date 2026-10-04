/** Shared workers.dev name prefix used for every deployment stage. */
const workerBaseName = "discord-announcement-email-bridge";

/** Worker identity and scheduled triggers derived from one deployment stage. */
export interface WorkerStageConfig {
  readonly name: string;
  readonly crons: string[];
}

/**
 * Validate a stage label and produce a legal Worker name and cron schedule.
 * Production polls each minute; non-production stages have no scheduled poll.
 * @param stage - Lowercase alphanumeric stage label with optional single hyphens.
 * @returns Worker identity and scheduled triggers for the stage.
 */
export const workerStageConfig = (stage: string): WorkerStageConfig => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(stage)) {
    throw new Error(
      "Worker stage names must use lowercase letters, numbers, and single hyphens"
    );
  }

  const name =
    stage === "prod" ? `${workerBaseName}-prod` : `${workerBaseName}-${stage}`;
  if (name.length > 63) {
    throw new Error(
      "Worker names for workers.dev must not exceed 63 characters"
    );
  }

  return {
    crons: stage === "prod" ? ["* * * * *"] : [],
    name,
  };
};
