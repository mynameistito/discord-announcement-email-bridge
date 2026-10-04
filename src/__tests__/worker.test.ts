import { describe, expect, it } from "vitest";

import type { WorkerEnv } from "../../alchemy.run";
import worker from "../worker";

describe("Worker health endpoint", () => {
  it("returns a secret-free stage and version response", async () => {
    // Fake secrets make this test fail if /healthz exposes secret bindings.
    const env = {
      ADMIN_TOKEN: "test-admin-token",
      BUILD_VERSION: "test-sha",
      DISCORD_BOT_TOKEN: "test-discord-token",
      RESEND_API_KEY: "test-resend-key",
      STAGE: "pr-12",
    } as WorkerEnv;
    const response = await worker.fetch(
      new Request("https://worker.example/healthz"),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      stage: "pr-12",
      status: "ok",
      version: "test-sha",
    });
  });
});
