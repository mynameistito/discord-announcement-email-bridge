export interface E2ESummaryInput {
  readonly jobStatus: string;
  readonly opOutcome: string;
  readonly installOutcome: string;
  readonly deployOutcome: string;
  readonly e2eOutcome: string;
  readonly destroyOutcome: string;
  readonly stage: string;
  readonly workerUrl: string;
  readonly runUrl: string;
  readonly e2eLog: string;
}

const statusMark = (outcome: string): string => {
  switch (outcome) {
    case "success": {
      return "✅";
    }
    case "skipped": {
      return "⏭️";
    }
    case "cancelled": {
      return "⏹️";
    }
    default: {
      return "❌";
    }
  }
};

/** Render the GitHub Actions summary for the isolated Discord E2E lifecycle. */
export const renderE2ESummary = (input: E2ESummaryInput): string => {
  const heading =
    input.e2eOutcome === "success"
      ? [
          "## ✅ Discord E2E passed",
          input.jobStatus === "success"
            ? "The complete Discord → Worker → Resend flow completed successfully."
            : "The Discord → Worker → Resend flow passed, but another lifecycle step failed.",
        ]
      : input.e2eOutcome === "failure"
        ? [
            "## ❌ Discord E2E failed",
            "Review the failed lifecycle step and its detailed log output.",
          ]
        : [
            "## ⚠️ Discord E2E did not complete",
            "Review the lifecycle outcomes and detailed log output.",
          ];

  const lines = [
    "",
    "",
    ...heading,
    "",
    `**Workflow status:** \`${input.jobStatus}\``,
    "",
    "| Lifecycle stage | Result |",
    "| --- | --- |",
    `| 1Password secret loading | ${statusMark(input.opOutcome)} \`${input.opOutcome}\` |`,
    `| Dependency installation | ${statusMark(input.installOutcome)} \`${input.installOutcome}\` |`,
    `| Isolated Worker deployment | ${statusMark(input.deployOutcome)} \`${input.deployOutcome}\` |`,
    `| Discord and Resend E2E test | ${statusMark(input.e2eOutcome)} \`${input.e2eOutcome}\` |`,
    `| Isolated Worker cleanup | ${statusMark(input.destroyOutcome)} \`${input.destroyOutcome}\` |`,
    "",
    "### Deployment details",
    "",
    `- **Stage:** \`${input.stage}\``,
    `- **Worker:** [${input.workerUrl}](${input.workerUrl})`,
    `- **Run:** [${input.runUrl}](${input.runUrl})`,
    "",
    "### E2E checkpoints",
    "",
    "```text",
    input.e2eLog.trim() || "No E2E runner log was produced.",
    "```",
    "",
  ];
  return lines.join("\n");
};
