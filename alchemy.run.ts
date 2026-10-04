import { Stack } from "alchemy";
import { D1, Queues, Worker, providers, state } from "alchemy/Cloudflare";
import type { InferEnv } from "alchemy/Cloudflare";
import { Redacted, String as StringConfig, withDefault } from "effect/Config";
import { gen, map } from "effect/Effect";

import { DeliveryQueue, DeliveryDeadLetterQueue } from "./src/resources";
import { workerStageConfig } from "./src/stage-config";

declare const process: {
  readonly env: {
    readonly ALCHEMY_STAGE?: string;
    readonly PREBUILT_WORKER?: string;
  };
};

const workerConfig = workerStageConfig(process.env.ALCHEMY_STAGE ?? "local");
const usePrebuiltWorker = process.env.PREBUILT_WORKER === "true";

const Database = D1.Database("BridgeDatabase", {
  migrations: "./migrations",
});

/** Cloudflare Worker entrypoint and infrastructure resources. */
export const BridgeWorker = Worker("DiscordAnnouncementEmailBridge", {
  bundle: !usePrebuiltWorker,
  compatibility: { date: "2026-10-03", flags: ["nodejs_compat"] },
  crons: workerConfig.crons,
  env: {
    ADMIN_TOKEN: Redacted("ADMIN_TOKEN").pipe(withDefault("")),
    BUILD_VERSION: StringConfig("BUILD_VERSION").pipe(
      withDefault("development")
    ),
    DB: Database,
    DELIVERY_DEAD_LETTER_QUEUE_NAME: DeliveryDeadLetterQueue.pipe(
      map((queue) => queue.queueName)
    ),
    DELIVERY_QUEUE: DeliveryQueue,
    DISCORD_BOT_TOKEN: Redacted("DISCORD_BOT_TOKEN").pipe(withDefault("")),
    DISCORD_GUILD_ID: StringConfig("DISCORD_GUILD_ID").pipe(withDefault("")),
    DISCORD_TARGET_CHANNEL_ID: StringConfig("DISCORD_TARGET_CHANNEL_ID").pipe(
      withDefault("")
    ),
    EMAIL_FROM_EMAIL: StringConfig("EMAIL_FROM_EMAIL").pipe(withDefault("")),
    EMAIL_FROM_NAME: StringConfig("EMAIL_FROM_NAME").pipe(withDefault("")),
    EMAIL_TO: StringConfig("EMAIL_TO").pipe(withDefault("")),
    RESEND_API_KEY: Redacted("RESEND_API_KEY").pipe(withDefault("")),
    SOURCE_CHANNEL_ID: StringConfig("SOURCE_CHANNEL_ID").pipe(withDefault("")),
    SOURCE_GUILD_ID: StringConfig("SOURCE_GUILD_ID").pipe(withDefault("")),
    STAGE: StringConfig("STAGE").pipe(withDefault("local")),
  },
  main: usePrebuiltWorker ? "./dist/worker.js" : "./src/worker.ts",
  name: workerConfig.name,
});
/** Runtime environment shape inferred from the configured Worker bindings. */
export type WorkerEnv = InferEnv<typeof BridgeWorker>;

export default Stack(
  "DiscordAnnouncementEmailBridge",
  { providers: providers(), state: state() },
  gen(function* buildBridgeStack() {
    const database = yield* Database;
    const queue = yield* DeliveryQueue;
    const deadLetterQueue = yield* DeliveryDeadLetterQueue;
    const worker = yield* BridgeWorker;
    yield* Queues.Consumer("DeliveryConsumer", {
      deadLetterQueue: deadLetterQueue.queueName,
      queueId: queue.queueId,
      scriptName: worker.workerName,
      settings: {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTimeMs: 5000,
        retryDelay: 60,
      },
    });
    yield* Queues.Consumer("DeliveryDeadLetterConsumer", {
      queueId: deadLetterQueue.queueId,
      scriptName: worker.workerName,
    });
    return {
      databaseName: database.databaseName,
      deadLetterQueueName: deadLetterQueue.queueName,
      queueName: queue.queueName,
      url: worker.url,
    };
  })
);
