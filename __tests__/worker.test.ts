import { makeD1Fixture } from "@tests/d1-fixture";
import { describe, expect, it } from "vitest";

import worker from "@/worker";

describe("Worker health endpoint", () => {
  it("returns a secret-free stage and version response", async () => {
    const fixture = await makeD1Fixture();

    try {
      const env = {
        ...fixture.env,
        ADMIN_TOKEN: "test-admin-token",
        BUILD_VERSION: "test-sha",
        DISCORD_BOT_TOKEN: "test-discord-token",
        RESEND_API_KEY: "test-resend-key",
        STAGE: "pr-12",
      };

      const response = await worker.fetch(
        new Request("https://example.test/healthz"),
        env
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toStrictEqual({
        stage: "pr-12",
        status: "ok",
        version: "test-sha",
      });
    } finally {
      await fixture.dispose();
    }
  });
});
