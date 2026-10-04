import { Effect } from "effect";

import type { Announcement } from "@/domain";

/**
 * Create a stable provider idempotency key scoped to one subscription,
 * announcement, and case-insensitive recipient without exposing the address.
 * @param announcement - Verified announcement being delivered.
 * @param recipient - Email recipient whose address is hashed into the key.
 * @returns An Effect containing the stable provider idempotency key.
 */
export const idempotencyKey = (
  announcement: Announcement,
  recipient: string
): Effect.Effect<string, Error> =>
  Effect.tryPromise({
    catch: () => new Error("Unable to generate delivery identity"),
    try: async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(recipient.toLowerCase())
      );
      const hash = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      return `discord-follow/${announcement.subscriptionId}/${announcement.message.id}/${hash}`;
    },
  });
