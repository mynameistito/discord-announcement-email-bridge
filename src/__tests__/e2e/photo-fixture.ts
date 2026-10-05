import { readFile } from "node:fs/promises";

import { Effect } from "effect";

import type { AnnouncementAttachment } from "@/__tests__/e2e/types.ts";

/** Read the committed public-domain image used by the live Discord E2E. */
export const photoAttachment: Effect.Effect<AnnouncementAttachment, Error> =
  Effect.tryPromise({
    catch: () => new Error("Could not read the E2E photo fixture"),
    try: async () => ({
      bytes: new Uint8Array(
        await readFile(new URL("../fixtures/e2e-photo.jpg", import.meta.url))
      ),
      filename: "e2e-photo.jpg",
      kind: "bytes" as const,
    }),
  });
