const workerBaseName = "discord-announcement-email-bridge";

export interface WorkerStageConfig {
  readonly name: string;
  readonly crons: string[];
}

export function workerStageConfig(stage: string): WorkerStageConfig {
  return {
    crons: stage === "prod" ? ["* * * * *"] : [],
    name:
      stage === "prod"
        ? `${workerBaseName}-prod`
        : `${workerBaseName}-${stage}`,
  };
}
