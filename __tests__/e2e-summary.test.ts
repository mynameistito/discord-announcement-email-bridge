import { renderE2ESummary } from "@scripts/e2e-summary-content.ts";
import { describe, expect, it } from "vitest";

const baseInput = {
  alchemyStage: "e2e-123-1",
  deployOutcome: "success",
  destroyOutcome: "success",
  e2eLog: "Checked Discord\nDelivery sent",
  e2eOutcome: "success",
  installOutcome: "success",
  jobStatus: "success",
  opOutcome: "success",
  runUrl: "https://github.com/acme/repo/actions/runs/123",
  workerUrl: "https://worker.example.test",
} as const;

describe("E2E workflow summary", () => {
  it("summarizes a successful run with every lifecycle stage and logs", () => {
    const summary = renderE2ESummary({
      ...baseInput,
      stage: baseInput.alchemyStage,
    });

    expect(summary).toContain("## ✅ Discord E2E passed");
    expect(summary).toContain("| Isolated Worker cleanup | ✅ `success` |");
    expect(summary).toContain("- **Stage:** `e2e-123-1`");
    expect(summary).toContain("Checked Discord\nDelivery sent");
  });

  it("reports failure and missing logs without hiding lifecycle results", () => {
    const summary = renderE2ESummary({
      ...baseInput,
      deployOutcome: "failure",
      e2eLog: "",
      e2eOutcome: "skipped",
      jobStatus: "failure",
      stage: baseInput.alchemyStage,
    });

    expect(summary).toContain("## ⚠️ Discord E2E did not complete");
    expect(summary).toContain("| Isolated Worker deployment | ❌ `failure` |");
    expect(summary).toContain("No E2E runner log was produced.");
  });
});
