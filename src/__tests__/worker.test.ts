import { describe, expect, it } from "vitest";

import type { WorkerEnv } from "../../alchemy.run";
import worker from "../worker";

describe("Worker health endpoint", () => {
  it("returns a secret-free stage and version response", async () => {
    // SAFETY: the /healthz route reads only BUILD_VERSION and STAGE from env.
    const env = { BUILD_VERSION: "test-sha", STAGE: "pr-12" } as WorkerEnv;
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
