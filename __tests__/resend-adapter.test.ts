import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendEmail } from "@/adapters/resend";

/** Minimal provider binding required by the Resend adapter contract. */
const env = { RESEND_API_KEY: "test-resend-key" };
/** Representative rendered email sent by the provider adapter tests. */
const payload = {
  from: "Bridge <bridge@example.test>",
  html: "<p>Update</p>",
  subject: "Announcement",
  text: "Update",
  to: ["reader@example.test"],
};

describe("Resend adapter", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the stable key and leaves retries to the queue", async () => {
    const idempotencyKeys: string[] = [];
    let responseStatus = 200;
    let attempts = 0;
    vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      idempotencyKeys.push(
        new Headers(init?.headers).get("Idempotency-Key") ?? ""
      );
      return Promise.resolve(
        Response.json(
          responseStatus === 200
            ? { id: "email-123" }
            : { message: "temporary failure" },
          { status: responseStatus }
        )
      );
    });

    const result = await Effect.runPromise(
      sendEmail(env, payload, "stable-delivery-key")
    );

    expect(result).toStrictEqual({ id: "email-123" });
    expect(idempotencyKeys).toStrictEqual(["stable-delivery-key"]);
    responseStatus = 503;
    attempts = 0;

    await expect(
      Effect.runPromise(sendEmail(env, payload, "stable-delivery-key"))
    ).rejects.toMatchObject({
      message: "Resend request failed (HTTP 503)",
      retryable: true,
      status: 503,
    });
    expect(attempts).toBe(1);
  });
});
