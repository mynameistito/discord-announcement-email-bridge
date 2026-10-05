import { setTimeout as pause } from "node:timers/promises";

import {
  configFromEnvironment,
  parseProfile,
  validateMode,
} from "@tests/e2e/config.ts";
import { isCompleteFollowerCopy } from "@tests/e2e/discord.ts";
import { waitUntil } from "@tests/e2e/http.ts";
import { photoAttachment } from "@tests/e2e/photo-fixture.ts";
import {
  announcementContent,
  announcementEmbed,
  simpleWebhookContent,
} from "@tests/e2e/types.ts";
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

  it("covers the requested Discord formatting in the announcement", () => {
    const content = announcementContent("E2E marker");
    expect(
      [
        "# E2E UUID E2E marker",
        "## Header 2",
        "### Header 3",
        "*Italics Text*",
        "**Bold Text**",
        "***Bold Italics Text***",
        "__Underline Text__",
        "~~Strikethrough Text~~",
        "- First Checkpoint Item",
        "- Second Checkpoint Item",
        "Inline Code: `inline code`",
        '```pwsh\nWrite-Output "E2E PowerShell"\n```',
        '```js\nconsole.log("E2E JavaScript");\n```',
        "Image attachment below.",
        "The rich embed title links to the Discord API.",
      ].every((example) => content.includes(example))
    ).toBeTruthy();
    expect(simpleWebhookContent("E2E marker")).toBe(
      "Simple E2E webhook message E2E marker"
    );
    expect(announcementEmbed("2026-10-05T12:00:00.000Z")).toMatchObject({
      author: {
        icon_url: expect.stringContaining("discordapp.com"),
        name: "E2E announcement author",
      },
      fields: [
        { inline: true, name: "Status", value: "All systems ready" },
        {
          inline: true,
          name: "Scenario",
          value: "Announcement crosspost",
        },
      ],
      footer: { text: "E2E webhook embed" },
      image: { url: "attachment://e2e-photo.jpg" },
      thumbnail: { url: expect.stringContaining("discordapp.com") },
      timestamp: "2026-10-05T12:00:00.000Z",
      title: "E2E rich embed",
    });
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

  it("waits for follower attachment and embed data before accepting the copy", () => {
    const followerCopy = {
      id: "follower-message",
      message_reference: { message_id: "source-message" },
    };
    expect(
      isCompleteFollowerCopy(
        followerCopy,
        "source-message",
        "e2e-photo.jpg",
        "E2E rich embed"
      )
    ).toBeFalsy();
    expect(
      isCompleteFollowerCopy(
        {
          ...followerCopy,
          attachments: [{ filename: "e2e-photo.jpg" }],
        },
        "source-message",
        "e2e-photo.jpg",
        "E2E rich embed"
      )
    ).toBeFalsy();
    expect(
      isCompleteFollowerCopy(
        {
          ...followerCopy,
          attachments: [{ filename: "e2e-photo.jpg" }],
          embeds: [
            {
              author: {
                icon_url: "https://example.test/author.png",
                name: "E2E announcement author",
              },
              fields: [{ name: "Status" }],
              footer: {
                icon_url: "https://example.test/footer.png",
                text: "E2E webhook embed",
              },
              image: { url: "https://example.test/photo.jpg" },
              thumbnail: { url: "https://example.test/thumbnail.png" },
              title: "E2E rich embed",
            },
          ],
        },
        "source-message",
        "e2e-photo.jpg",
        "E2E rich embed"
      )
    ).toBeTruthy();
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
