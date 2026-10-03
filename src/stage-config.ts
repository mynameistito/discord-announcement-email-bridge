const workerBaseName = "discord-announcement-email-bridge";

export interface WorkerStageConfig {
  readonly name: string;
  readonly crons: string[];
}

export function workerStageConfig(stage: string): WorkerStageConfig {
  const isPullRequestPreview = /^pr-[1-9]\d*$/u.test(stage);
  return {
    crons: isPullRequestPreview ? [] : ["* * * * *"],
    name:
      stage === "prod"
        ? `${workerBaseName}-prod`
        : `${workerBaseName}-${stage}`,
  };
}
