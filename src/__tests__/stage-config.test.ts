import { describe, expect, it } from "vitest";

import { workerStageConfig } from "@/stage-config";

describe("worker stage configuration", () => {
  it("uses the production URL name and keeps its polling cron", () => {
    expect(workerStageConfig("prod")).toStrictEqual({
      crons: ["* * * * *"],
      name: "discord-announcement-email-bridge-prod",
    });
  });

  it("names PR workers by number and disables their cron", () => {
    expect(workerStageConfig("pr-123")).toStrictEqual({
      crons: [],
      name: "discord-announcement-email-bridge-pr-123",
    });
  });

  it("leaves non-production local stages without a cron", () => {
    expect(workerStageConfig("local")).toStrictEqual({
      crons: [],
      name: "discord-announcement-email-bridge-local",
    });
  });

  it("rejects stage values that cannot form a workers.dev name", () => {
    expect(() => workerStageConfig("dev_test")).toThrow(/single hyphens/u);
    expect(() => workerStageConfig(`pr-${"1".repeat(40)}`)).toThrow(
      /63 characters/u
    );
  });
});
