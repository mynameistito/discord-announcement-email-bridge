import { describe, expect, it } from "vitest";

import { healthResponse } from "@/application/admin";

describe("Worker health endpoint", () => {
  it("returns a secret-free stage and version response", async () => {
    const response = healthResponse({
      BUILD_VERSION: "test-sha",
      STAGE: "pr-12",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toStrictEqual({
      stage: "pr-12",
      status: "ok",
      version: "test-sha",
    });
  });
});
