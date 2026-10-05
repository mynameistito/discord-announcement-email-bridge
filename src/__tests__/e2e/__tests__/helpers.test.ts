import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  configFromEnvironment,
  parseProfile,
  validateMode,
} from "../config.ts";
import { photoAttachment } from "../photo-fixture.ts";
import { announcementContent } from "../types.ts";
import { normalizedWorkerUrl } from "../worker.ts";

describe("E2E helpers", () => {
  it("parses profile flags in both supported forms", () => {
    expect(parseProfile(["--profile", "preview"])).toBe("preview");
    expect(parseProfile(["--profile=preview"])).toBe("preview");
    expect(parseProfile([])).toBeUndefined();
    expect(() => parseProfile(["--profile", "--remote"])).toThrow(
      "--profile requires"
    );
  });

  it("requires all live E2E credentials", () => {
    expect(() => configFromEnvironment({})).toThrow(
      "Missing required E2E configuration"
    );
    expect(() => validateMode(true, "preview")).toThrow("only for local");
  });

  it("provides trimmed Worker URLs and Markdown coverage in the announcement", () => {
    expect(normalizedWorkerUrl("https://example.test///")).toBe(
      "https://example.test"
    );
    const content = announcementContent("E2E marker");
    expect(content).toContain("**E2E announcement**");
    expect(content).toContain("*Testing Discord Markdown rendering.*");
    expect(content).toContain("- First checklist item");
    expect(content).toContain("`const e2e = true`");
    expect(content).toContain(
      "[Discord API](https://discord.com/developers/docs/intro)"
    );
  });

  it("loads the committed JPEG used by the live Discord upload", async () => {
    const attachment = await Effect.runPromise(photoAttachment);
    expect(attachment.kind).toBe("bytes");
    if (attachment.kind !== "bytes") {
      throw new Error("fixture should load as bytes");
    }
    expect(attachment.filename).toBe("e2e-photo.jpg");
    expect([...attachment.bytes.slice(0, 3)]).toStrictEqual([255, 216, 255]);
  });
});
