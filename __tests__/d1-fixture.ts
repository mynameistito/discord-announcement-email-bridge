import { readFile, readdir } from "node:fs/promises";

import { Miniflare } from "miniflare";

import type { WorkerEnv } from "@/alchemy.run";

/** A local Workers runtime with a migrated D1 database. */
export interface D1Fixture {
  readonly env: WorkerEnv;
  readonly dispose: () => Promise<void>;
}

/** Start an isolated local D1 database and apply the production migrations. */
export const makeD1Fixture = async (): Promise<D1Fixture> => {
  const runtime = new Miniflare({
    d1Databases: { DB: "bridge-tests" },
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
  });

  try {
    const DB = await runtime.getD1Database("DB");

    const migrationDir = new URL("../migrations/", import.meta.url);
    const entries = await readdir(migrationDir);

    const names = entries.filter((name) => name.endsWith(".sql")).toSorted();

    const migrations = await Promise.all(
      names.map(
        async (name) => await readFile(new URL(name, migrationDir), "utf-8")
      )
    );

    const statements = migrations.flatMap((sql) =>
      sql.split(";").flatMap((part) => {
        const statement = part.trim();

        return statement === "" ? [] : [DB.prepare(statement)];
      })
    );

    await DB.batch(statements);

    const env: WorkerEnv = {
      ADMIN_TOKEN: "test-admin-token",
      BUILD_VERSION: "test-build",
      DB,
      DELIVERY_DEAD_LETTER_QUEUE_NAME: "dead-letter",
      DELIVERY_QUEUE: {
        metrics: async () =>
          await Promise.resolve({ backlogBytes: 0, backlogCount: 0 }),
        send: async () =>
          await Promise.resolve({
            metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
          }),
        sendBatch: async () =>
          await Promise.resolve({
            metadata: { metrics: { backlogBytes: 0, backlogCount: 0 } },
          }),
      },
      DISCORD_BOT_TOKEN: "test-discord-token",
      DISCORD_GUILD_ID: "test-guild",
      DISCORD_TARGET_CHANNEL_ID: "test-channel",
      EMAIL_FROM_EMAIL: "test@example.test",
      EMAIL_FROM_NAME: "Test",
      EMAIL_TO: "recipient@example.test",
      RESEND_API_KEY: "test-resend-key",
      SOURCE_CHANNEL_ID: "",
      SOURCE_GUILD_ID: "",
      STAGE: "test",
    };

    return {
      dispose: async () => {
        await runtime.dispose();
      },
      env,
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
};
