import { Cause } from "effect";
import { describe, expect, it } from "vitest";

import { safeError } from "@/application/admin";
import { BridgeInfrastructureError } from "@/bridge-infrastructure-error";

describe(safeError, () => {
  it("does not expose arbitrary error messages", () => {
    const cause = Cause.fail(new Error("secret credential"));

    expect(safeError(cause)).toBe("Unexpected failure");
  });

  it("returns the stable message for known infrastructure errors", () => {
    const cause = Cause.fail(
      new BridgeInfrastructureError("queue_send", "secret credential")
    );

    expect(safeError(cause)).toBe(
      "Bridge infrastructure operation failed: queue_send"
    );
  });
});
