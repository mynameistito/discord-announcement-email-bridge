import { describe, expect, it } from "vitest";

import { describeDiscordFailure } from "../discord-diagnostics";

describe("Discord REST failure diagnostics", () => {
  it("identifies message-history access failures without logging the channel ID", () => {
    expect(
      describeDiscordFailure("/channels/123456/messages?limit=100", 403, {
        code: 50_001,
        message: "Missing Access",
      })
    ).toBe(
      "Discord REST GET /channels/{channel_id}/messages returned 403 (Discord error 50001: Missing Access; required bot permissions: VIEW_CHANNEL, READ_MESSAGE_HISTORY)"
    );
  });

  it("identifies webhook permission failures without logging the webhook ID", () => {
    expect(
      describeDiscordFailure("/webhooks/654321", 403, {
        code: 50_013,
        message: "Missing Permissions",
      })
    ).toBe(
      "Discord REST GET /webhooks/{webhook_id} returned 403 (Discord error 50013: Missing Permissions; required bot permissions: MANAGE_WEBHOOKS in the destination channel)"
    );
  });

  it("does not include unrecognized response messages or raw IDs", () => {
    expect(
      describeDiscordFailure("/webhooks/654321?token=secret", 403, {
        code: 123_456,
        message: "private content or token=secret",
      })
    ).toBe(
      "Discord REST GET /webhooks/{webhook_id} returned 403 (Discord error 123456; required bot permissions: MANAGE_WEBHOOKS in the destination channel)"
    );
  });

  it("does not expose unrecognized paths or missing error payloads", () => {
    expect(describeDiscordFailure("/private/123456?token=secret", 403)).toBe(
      "Discord REST GET an endpoint returned 403"
    );
  });

  it("does not suggest permission changes for other HTTP failures", () => {
    expect(describeDiscordFailure("/channels/123456/messages", 500)).toBe(
      "Discord REST GET /channels/{channel_id}/messages returned 500"
    );
  });
});
