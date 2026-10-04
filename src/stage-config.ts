const workerBaseName = "discord-announcement-email-bridge";

export interface WorkerStageConfig {
  readonly name: string;
  readonly crons: string[];
}

export function workerStageConfig(stage: string): WorkerStageConfig {
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
}
