import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import { DeliveryQueue, DeliveryDeadLetterQueue } from "./src/resources";

const Database = Cloudflare.D1.Database("BridgeDatabase", {
  migrations: "./migrations",
});

/** Cloudflare Worker entrypoint and infrastructure resources. */
export const BridgeWorker = Cloudflare.Worker("DiscordEmailBridge", {
  compatibility: { date: "2026-10-03", flags: ["nodejs_compat"] },
  crons: ["* * * * *"],
  env: {
    ADMIN_TOKEN: Config.Redacted("ADMIN_TOKEN").pipe(Config.withDefault("")),
    BUILD_VERSION: Config.String("BUILD_VERSION").pipe(
      Config.withDefault("development")
    ),
    DB: Database,
    DELIVERY_DEAD_LETTER_QUEUE_NAME: Config.String(
      "DELIVERY_DEAD_LETTER_QUEUE_NAME"
    ).pipe(Config.withDefault("")),
    DELIVERY_QUEUE: DeliveryQueue,
    DISCORD_BOT_TOKEN: Config.Redacted("DISCORD_BOT_TOKEN").pipe(
      Config.withDefault("")
    ),
    DISCORD_GUILD_ID: Config.String("DISCORD_GUILD_ID").pipe(
      Config.withDefault("")
    ),
    DISCORD_TARGET_CHANNEL_ID: Config.String("DISCORD_TARGET_CHANNEL_ID").pipe(
      Config.withDefault("")
    ),
    EMAIL_FROM: Config.String("EMAIL_FROM").pipe(Config.withDefault("")),
    EMAIL_TO: Config.String("EMAIL_TO").pipe(Config.withDefault("")),
    RESEND_API_KEY: Config.Redacted("RESEND_API_KEY").pipe(
      Config.withDefault("")
    ),
    SOURCE_CHANNEL_ID: Config.String("SOURCE_CHANNEL_ID").pipe(
      Config.withDefault("")
    ),
    SOURCE_GUILD_ID: Config.String("SOURCE_GUILD_ID").pipe(
      Config.withDefault("")
    ),
    STAGE: Config.String("STAGE").pipe(Config.withDefault("local")),
  },
  main: "./src/worker.ts",
});

/** Runtime environment shape inferred from the configured Worker bindings. */
export type WorkerEnv = Cloudflare.InferEnv<typeof BridgeWorker>;

export default Alchemy.Stack(
  "DiscordEmailBridge",
  { providers: Cloudflare.providers(), state: Cloudflare.state() },
  Effect.gen(function* buildBridgeStack() {
    const database = yield* Database;
    const queue = yield* DeliveryQueue;
    const deadLetterQueue = yield* DeliveryDeadLetterQueue;
    const worker = yield* BridgeWorker;
    yield* Cloudflare.Queues.Consumer("DeliveryConsumer", {
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
    yield* Cloudflare.Queues.Consumer("DeliveryDeadLetterConsumer", {
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
