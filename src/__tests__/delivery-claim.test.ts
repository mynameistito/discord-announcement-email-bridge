import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeRepository } from "@/adapters/d1";
import { processQueue } from "@/adapters/queue";
import type { WorkerEnv } from "@/alchemy.run";

const deliveryId = "delivery-123";
const announcementId = "announcement-123";
const payload = { announcementId, deliveryId };
const message = {
  attachments: [],
  author: { username: "news" },
  channel_id: "destination",
  content: "Announcement",
  embeds: [],
  flags: 2,
  id: "123",
  timestamp: "2026-10-03T10:00:00Z",
  type: 0,
};

const makeDatabase = () => {
  let status = "queued";
  let claimToken: string | null = null;
  let claimExpiresAt = 0;
  const database = {
    prepare(query: string) {
      let values: readonly unknown[] = [];
      const statement = {
        all: async <T>() => ({
          results: query.startsWith("SELECT d.id AS delivery_id") &&
              status === "pending"
            ? ([
                {
                  announcement_id: announcementId,
                  delivery_id: deliveryId,
                },
              ] as T[])
            : ([] as T[]),
        }),
        bind(...parameters: unknown[]) {
          values = parameters;
          return statement;
        },
        async first<T>() {
          const now = Date.now();
          if (query.startsWith("UPDATE deliveries SET claim_token")) {
            if (
              status !== "sent" &&
              status !== "failed" &&
              (!claimToken || claimExpiresAt <= now)
            ) {
              claimToken = String(values[0]);
              claimExpiresAt = now + 120_000;
              return { id: deliveryId } as T;
            }
            return null;
          }
          if (query.startsWith("SELECT id FROM deliveries")) {
            return claimToken && claimExpiresAt > now
              ? ({ id: deliveryId } as T)
              : null;
          }
          if (query.startsWith("SELECT id, announcement_id, recipient")) {
            return {
              announcement_id: announcementId,
              id: deliveryId,
              idempotency_key: "stable-key",
              recipient: "reader@example.test",
              status,
            } as T;
          }
          if (query.startsWith("SELECT normalized_payload")) {
            return {
              follower_webhook_id: "webhook",
              normalized_payload: JSON.stringify(message),
              source_channel_id: "source",
              source_guild_id: "guild",
              source_message_id: "123",
              subscription_id: "subscription",
            } as T;
          }
          if (query.startsWith("UPDATE deliveries SET status = 'sent'")) {
            if (claimToken !== values[2]) {
              return null;
            }
            status = "sent";
            claimToken = null;
            claimExpiresAt = 0;
            return { id: deliveryId } as T;
          }
          throw new Error(`Unexpected D1 first query: ${query}`);
        },
        async run() {
          if (query.startsWith("UPDATE deliveries SET status = 'pending'")) {
            if (claimToken && claimExpiresAt <= Date.now()) {
              status = "pending";
              claimToken = null;
              claimExpiresAt = 0;
            }
          }
          return { meta: { changes: 0 }, success: true };
        },
      };
      return statement;
    },
  };
  // SAFETY: this fake implements only the prepared-statement methods exercised by processQueue.
  return {
    database: database as unknown as D1Database,
    expireClaim: () => {
      status = "queued";
      claimToken = "abandoned-claim";
      claimExpiresAt = Date.now() - 1;
    },
    status: () => status,
  };
};

const workerEnv = (database: D1Database): WorkerEnv => {
  // SAFETY: the exercised paths read only these configured bindings.
  return {
    DB: database,
    DELIVERY_DEAD_LETTER_QUEUE_NAME: "dead-letter",
    EMAIL_FROM_EMAIL: "bridge@example.test",
    EMAIL_FROM_NAME: "Bridge",
    RESEND_API_KEY: "test-key",
  } as WorkerEnv;
};

describe("delivery claim", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends only once when duplicate queue messages arrive concurrently", async () => {
    const fake = makeDatabase();
    let emailCalls = 0;
    let markBusyRetry: () => void = () => {};
    const busyRetry = new Promise<void>((resolve) => {
      markBusyRetry = resolve;
    });
    let markEmailStarted: () => void = () => {};
    const emailStarted = new Promise<void>((resolve) => {
      markEmailStarted = resolve;
    });
    let finishEmail: (response: Response) => void = () => {};
    const emailResponse = new Promise<Response>((resolve) => {
      finishEmail = resolve;
    });
    vi.stubGlobal("fetch", () => {
      emailCalls += 1;
      markEmailStarted();
      return emailResponse;
    });

    const first = {
      attempts: 1,
      body: payload,
      retry: () => markBusyRetry(),
    };
    const duplicate = {
      attempts: 1,
      body: payload,
      retry: () => markBusyRetry(),
    };
    const env = workerEnv(fake.database);
    const batch = {
      messages: [first, duplicate],
      queue: "delivery-queue",
    } as unknown as MessageBatch<unknown>;

    const processing = processQueue(batch, env);
    await Promise.all([emailStarted, busyRetry]);
    expect(emailCalls).toBe(1);

    finishEmail(Response.json({ id: "resend-123" }));
    await processing;

    expect(emailCalls).toBe(1);
    expect(fake.status()).toBe("sent");
  });

  it("requeues deliveries whose worker claim expired", async () => {
    const fake = makeDatabase();
    fake.expireClaim();
    const repository = makeRepository(workerEnv(fake.database));

    const pending = await Effect.runPromise(
      repository.pendingDeliveries("subscription")
    );

    expect(pending).toStrictEqual([{ announcementId, deliveryId }]);
    expect(fake.status()).toBe("pending");
  });
});
