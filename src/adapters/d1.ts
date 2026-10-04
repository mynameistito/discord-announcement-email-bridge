import { Effect } from "effect";

import { idempotencyKey } from "@/adapters/idempotency-key";
import type { WorkerEnv } from "@/alchemy.run";
import type { PollingPorts } from "@/application/polling";
import { BridgeInfrastructureError } from "@/bridge-infrastructure-error";
import type { Announcement, Subscription } from "@/domain";

export const d1 = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    catch: (cause) => new BridgeInfrastructureError("d1", cause, true),
    try: operation,
  });

const toSubscription = (row: SubscriptionRow): Subscription => ({
  destinationChannelId: row.destination_channel_id,
  destinationGuildId: row.destination_guild_id,
  emailTo: row.email_to,
  id: row.id,
  ...(row.source_guild_id ? { sourceGuildId: row.source_guild_id } : undefined),
  ...(row.source_channel_id
    ? { sourceChannelId: row.source_channel_id }
    : undefined),
});

export const persistBatch = (
  env: WorkerEnv,
  subscription: Subscription,
  announcements: readonly Announcement[],
  cursor: string | undefined
) =>
  Effect.gen(function* persistBatchEffect() {
    const statements: D1PreparedStatement[] = [];
    for (const announcement of announcements) {
      const announcementId = `${subscription.id}:${announcement.message.id}`;
      const deliveryId = `${announcementId}:${subscription.emailTo.toLowerCase()}`;
      const key = yield* idempotencyKey(
        announcement,
        subscription.emailTo
      ).pipe(
        Effect.mapError(
          (cause) => new BridgeInfrastructureError("idempotency_key", cause)
        )
      );
      statements.push(
        env.DB.prepare(
          "INSERT OR IGNORE INTO announcements (id, subscription_id, discord_message_id, source_guild_id, source_channel_id, source_message_id, follower_webhook_id, normalized_payload, message_created_at, edited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          announcementId,
          subscription.id,
          announcement.message.id,
          announcement.sourceGuildId,
          announcement.sourceChannelId,
          announcement.sourceMessageId,
          announcement.followerWebhookId,
          JSON.stringify(announcement.message),
          announcement.message.timestamp,
          announcement.message.edited_timestamp ?? null
        ),
        env.DB.prepare(
          "INSERT OR IGNORE INTO deliveries (id, announcement_id, recipient, status, idempotency_key) SELECT ?, id, ?, 'pending', ? FROM announcements WHERE id = ?"
        ).bind(deliveryId, subscription.emailTo, key, announcementId)
      );
    }
    if (cursor !== undefined) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO channel_cursors (subscription_id, last_message_id) VALUES (?, ?) ON CONFLICT(subscription_id) DO UPDATE SET last_message_id = excluded.last_message_id, updated_at = CURRENT_TIMESTAMP"
        ).bind(subscription.id, cursor)
      );
    }
    for (let offset = 0; offset < statements.length; offset += 100) {
      const result = yield* d1(() =>
        env.DB.batch(statements.slice(offset, offset + 100))
      );
      if (result.some((entry) => !entry.success)) {
        return yield* Effect.fail(
          new BridgeInfrastructureError("persist_discovery", "D1 batch failed")
        );
      }
    }
  });

export const makeRepository = (env: WorkerEnv): PollingPorts["repository"] => ({
  cursor: (id) =>
    d1(() =>
      env.DB.prepare(
        "SELECT last_message_id FROM channel_cursors WHERE subscription_id = ?"
      )
        .bind(id)
        .first<CursorRow>()
    ).pipe(Effect.map((row) => row?.last_message_id ?? undefined)),
  enabledSubscriptions: () =>
    d1(() =>
      env.DB.prepare(
        "SELECT id, destination_guild_id, destination_channel_id, source_guild_id, source_channel_id, email_to FROM subscriptions WHERE enabled = 1"
      ).all<SubscriptionRow>()
    ).pipe(Effect.map((result) => result.results.map(toSubscription))),
  initializeCursor: (id, messageId) =>
    d1(() =>
      env.DB.prepare(
        "INSERT INTO channel_cursors (subscription_id, last_message_id) VALUES (?, ?) ON CONFLICT(subscription_id) DO UPDATE SET last_message_id = excluded.last_message_id, updated_at = CURRENT_TIMESTAMP WHERE channel_cursors.last_message_id IS NULL"
      )
        .bind(id, messageId ?? null)
        .run()
    ).pipe(Effect.asVoid),
  markEnqueued: (id) =>
    d1(() =>
      env.DB.prepare(
        "UPDATE deliveries SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
      )
        .bind(id)
        .run()
    ).pipe(Effect.asVoid),
  pendingDeliveries: (id) =>
    Effect.gen(function* pendingDeliveriesEffect() {
      yield* d1(() =>
        env.DB.prepare(
          "UPDATE deliveries SET status = 'pending', claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'queued' AND claim_token IS NOT NULL AND claim_expires_at <= CURRENT_TIMESTAMP"
        ).run()
      );
      const result = yield* d1(() =>
        env.DB.prepare(
          "SELECT d.id AS delivery_id, d.announcement_id FROM deliveries d JOIN announcements a ON a.id = d.announcement_id WHERE a.subscription_id = ? AND d.status = 'pending' ORDER BY d.created_at LIMIT 500"
        )
          .bind(id)
          .all<DeliveryRow>()
      );
      return result.results.map((row) => ({
        announcementId: row.announcement_id,
        deliveryId: row.delivery_id,
      }));
    }),
  persistDiscoveryBatch: (subscription, announcements, cursor) =>
    persistBatch(env, subscription, announcements, cursor),
});

export const ensureSubscription = (
  env: WorkerEnv,
  subscription: Subscription
) =>
  d1(() =>
    env.DB.batch([
      env.DB.prepare(
        "UPDATE subscriptions SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id != ? AND enabled = 1"
      ).bind(subscription.id),
      env.DB.prepare(
        "INSERT INTO subscriptions (id, destination_guild_id, destination_channel_id, source_guild_id, source_channel_id, email_to, enabled) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET destination_guild_id = excluded.destination_guild_id, destination_channel_id = excluded.destination_channel_id, source_guild_id = excluded.source_guild_id, source_channel_id = excluded.source_channel_id, email_to = excluded.email_to, enabled = 1, updated_at = CURRENT_TIMESTAMP"
      ).bind(
        subscription.id,
        subscription.destinationGuildId,
        subscription.destinationChannelId,
        subscription.sourceGuildId ?? null,
        subscription.sourceChannelId ?? null,
        subscription.emailTo
      ),
    ])
  ).pipe(Effect.asVoid);

export const updateDeliveryFailure = (
  env: WorkerEnv,
  id: string,
  error: string,
  retryable: boolean,
  claimToken: string
) =>
  d1(() =>
    env.DB.prepare(
      "UPDATE deliveries SET status = ?, attempts = attempts + 1, last_error = ?, claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'sent' AND claim_token = ?"
    )
      .bind(
        retryable ? "queued" : "failed",
        error.slice(0, 500),
        id,
        claimToken
      )
      .run()
  ).pipe(Effect.asVoid);

export const markDeadLetter = (env: WorkerEnv, id: string) =>
  d1(() =>
    env.DB.prepare(
      "UPDATE deliveries SET status = 'failed', last_error = 'queue_retry_exhausted', claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'sent' AND (claim_token IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP)"
    )
      .bind(id)
      .run()
  ).pipe(Effect.map((result) => result.meta.changes > 0));

/**
 * Atomically claim a queued delivery or report its current ownership state.
 * The two-minute lease exceeds the Resend adapter's 60-second request timeout.
 */
export const claimDelivery = (
  env: WorkerEnv,
  id: string,
  announcementId: string,
  claimToken: string
) =>
  Effect.gen(function* claimDeliveryEffect() {
    const claimed = yield* d1(() =>
      env.DB.prepare(
        "UPDATE deliveries SET claim_token = ?, claim_expires_at = datetime('now', '+2 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND announcement_id = ? AND status IN ('pending', 'queued') AND (claim_token IS NULL OR claim_expires_at <= CURRENT_TIMESTAMP) RETURNING id"
      )
        .bind(claimToken, id, announcementId)
        .first<ClaimRow>()
    );
    if (claimed) {
      return "claimed" as const;
    }
    const activeClaim = yield* d1(() =>
      env.DB.prepare(
        "SELECT id FROM deliveries WHERE id = ? AND announcement_id = ? AND status IN ('pending', 'queued') AND claim_token IS NOT NULL AND claim_expires_at > CURRENT_TIMESTAMP"
      )
        .bind(id, announcementId)
        .first<ClaimRow>()
    );
    return activeClaim ? ("in_flight" as const) : ("complete" as const);
  });

interface SubscriptionRow {
  readonly id: string;
  readonly destination_guild_id: string;
  readonly destination_channel_id: string;
  readonly source_guild_id: string | null;
  readonly source_channel_id: string | null;
  readonly email_to: string;
}
interface CursorRow {
  readonly last_message_id: string | null;
}
interface DeliveryRow {
  readonly delivery_id: string;
  readonly announcement_id: string;
}
interface ClaimRow {
  readonly id: string;
}
