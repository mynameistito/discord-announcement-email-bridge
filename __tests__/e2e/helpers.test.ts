import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
import { setTimeout as pause } from "node:timers/promises";

import {
  configFromEnvironment,
  parseProfile,
  validateMode,
} from "@tests/e2e/config.ts";
import { isCompleteFollowerCopy } from "@tests/e2e/discord.ts";
import { jsonRequest, waitUntil } from "@tests/e2e/http.ts";
import { waitForExit } from "@tests/e2e/local-worker.ts";
import { photoAttachment } from "@tests/e2e/photo-fixture.ts";
import {
  announcementContent,
  announcementEmbed,
  simpleWebhookContent,
} from "@tests/e2e/types.ts";
import { normalizedWorkerUrl, waitForDelivery } from "@tests/e2e/worker.ts";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";

const delayedProbe = (delay: number) => async () => {
  await pause(delay);

  return true;
};

describe("E2E helpers", () => {
  it("rejects JSON that does not match the endpoint schema", async () => {
    vi.stubGlobal(
      "fetch",
      async () => await Promise.resolve(Response.json({ id: 42 }))
    );

    try {
      await expect(
        jsonRequest(
          "https://example.test",
          {},
          "Test endpoint",
          new AbortController().signal,
          Schema.Struct({ id: Schema.String })
        )
      ).rejects.toThrow("Test endpoint returned an invalid response");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves cancellation while reading a response body", async () => {
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    const response = new Response("{}");

    vi.spyOn(response, "json").mockImplementation(async () => {
      controller.abort(reason);

      return await Promise.reject(reason);
    });
    vi.stubGlobal("fetch", async () => await Promise.resolve(response));

    try {
      const result = jsonRequest(
        "https://example.test",
        { signal: controller.signal },
        "Test endpoint",
        new AbortController().signal,
        Schema.Struct({ id: Schema.String })
      );

      await expect(result).rejects.toBe(reason);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["targetSentDeliveries", "targetFailedDeliveries"])(
    "rejects invalid %s before evaluating delivery completion",
    async (field) => {
      vi.stubGlobal(
        "fetch",
        async () =>
          await Promise.resolve(
            Response.json(
              Object.fromEntries([
                ["failedDeliveries", 0],
                ["sentDeliveries", 0],
                [field, 0.5],
              ])
            )
          )
      );

      try {
        const config = configFromEnvironment({
          ADMIN_PREVIEW_TOKEN: "test",
          DISCORD_E2E_ANNOUNCEMENT_CHANNEL_ID: "test",
          DISCORD_E2E_RECEIVER_CHANNEL_ID: "test",
          DISCORD_GUILD_ID: "test",
          DISCORD_PREVIEW_BOT_TOKEN: "test",
          EMAIL_FROM_EMAIL: "test@example.test",
          EMAIL_FROM_NAME: "Test",
          EMAIL_TO: "test@example.test",
          RESEND_PREVIEW_API_KEY: "test",
        });

        await expect(
          waitForDelivery(
            "https://example.test",
            config,
            "test",
            new AbortController().signal,
            () => {}
          )
        ).rejects.toThrow(
          "Worker status response contains invalid delivery counts"
        );
      } finally {
        vi.unstubAllGlobals();
      }
    }
  );

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
    expect(() => {
      validateMode(true, "preview");
    }).toThrow("only for local");
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
    const embed = announcementEmbed("2026-10-05T12:00:00.000Z");

    expect(embed.author?.icon_url).toContain("discordapp.com");
    expect(embed.thumbnail?.url).toContain("discordapp.com");
    expect(embed).toMatchObject({
      author: {
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

  it("recognizes an embedded attachment without separate attachment metadata", () => {
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
              image: {
                url: "https://cdn.discordapp.com/attachments/1/2/e2e-photo.jpg?ex=abc",
              },
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

  it("treats an aborted exit-wait signal as a timeout", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );

    try {
      await once(child, "spawn");
      await expect(waitForExit(child, 1)).resolves.toBeFalsy();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = once(child, "exit");
        child.kill("SIGKILL");
        await exit;
      }
    }
  });
});
