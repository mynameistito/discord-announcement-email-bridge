import { setTimeout as pause } from "node:timers/promises";

import {
  configFromEnvironment,
  parseProfile,
  validateMode,
} from "@tests/e2e/config.ts";
import { waitUntil } from "@tests/e2e/http.ts";
import { photoAttachment } from "@tests/e2e/photo-fixture.ts";
import { announcementContent } from "@tests/e2e/types.ts";
import { normalizedWorkerUrl } from "@tests/e2e/worker.ts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

const delayedProbe = (delay: number) => async () => {
  await pause(delay);
  return true;
};

describe("E2E helpers", () => {
  it("parses profile flags in both supported forms", () => {
    expect(parseProfile(["--profile", "preview"])).toBe("preview");
    expect(parseProfile(["--profile=preview"])).toBe("preview");
    expect(parseProfile([])).toBeUndefined();
    expect(
      ["--profile --remote", "--profile="].map((argument) => {
        try {
          parseProfile(argument.split(" "));
          return "accepted";
        } catch (error) {
          return error instanceof Error ? error.message : "unknown error";
        }
      })
    ).toStrictEqual([
      "--profile requires an Alchemy profile name",
      "--profile requires an Alchemy profile name",
    ]);
  });

  it("requires all live E2E credentials", () => {
    expect(() => configFromEnvironment({})).toThrow(
      "Missing required E2E configuration"
    );
    expect(() => validateMode(true, "preview")).toThrow("only for local");
  });

  it("trims trailing slashes from Worker URLs", () => {
    expect(normalizedWorkerUrl("https://example.test///")).toBe(
      "https://example.test"
    );
  });

  it("covers Discord Markdown in the announcement", () => {
    const content = announcementContent("E2E marker");
    expect(
      [
        "**E2E announcement**",
        "*Testing Discord Markdown rendering.*",
        "- First checklist item",
        "`const e2e = true`",
        "[Discord API](https://discord.com/developers/docs/intro)",
      ].every((example) => content.includes(example))
    ).toBeTruthy();
  });

  it("loads the committed JPEG used by the live Discord upload", async () => {
    const attachment = await Effect.runPromise(photoAttachment);
    if (attachment.kind !== "bytes") {
      throw new Error("fixture should load as bytes");
    }
    expect(attachment.filename).toBe("e2e-photo.jpg");
    expect(Uint8Array.from(attachment.bytes.subarray(0, 3))).toStrictEqual(
      new Uint8Array([255, 216, 255])
    );
  });

  it("does not accept a successful probe that completes after its deadline", async () => {
    await expect(
      waitUntil(
        delayedProbe(20),
        Boolean,
        1,
        5,
        "probe deadline exceeded",
        new AbortController().signal
      )
    ).rejects.toThrow("probe deadline exceeded");
  });
});
