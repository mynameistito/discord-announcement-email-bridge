import { Effect, Schema } from "effect";

import { d1 } from "@/adapters/d1";
import { sendEmail } from "@/adapters/resend";
import type { WorkerEnv } from "@/alchemy.run";
import { ApiError } from "@/application/delivery-error";
import { BridgeInfrastructureError } from "@/bridge-infrastructure-error";
import { MessageSchema, renderHtml, renderText } from "@/domain";
import type { Announcement } from "@/domain";

/** Decode the JSON payload stored with each durable announcement row. */
const StoredMessageSchema = Schema.fromJsonString(MessageSchema);

/**
 * Build a bounded, newline-free email subject from announcement text.
 * @param announcement - Verified announcement to summarize.
 * @returns A sanitized subject line of at most 150 characters.
 */
export const emailSubject = (announcement: Announcement): string => {
  const title = announcement.message.embeds.find((embed) => embed.title)?.title;
  const safeTitle = (title ?? announcement.message.content)
    .replaceAll(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 100);
  return safeTitle
    ? `[Discord] Announcement — ${safeTitle}`.slice(0, 150)
    : "[Discord] New announcement";
};

/**
 * Sanitize sender display name and address before composing the From header.
 * @param name - Sender display name.
 * @param address - Sender email address.
 * @returns A sanitized RFC-style From header value.
 */
const emailSender = (name: string, address: string): string =>
  `${name.trim().replaceAll(/[\r\n<>]+/gu, " ")} <${address.trim().replaceAll(/[\r\n<>]/gu, "")}>`;

/**
 * Load and validate a persisted announcement, send its email with a stable
 * provider idempotency key, and mark it sent only if the claim token still owns it.
 * @param env - Worker bindings for D1 and Resend.
 * @param claimToken - Token proving ownership of the active delivery lease.
 * @param deliveryId - Durable delivery row identifier.
 * @param announcementId - Durable announcement row identifier.
 * @returns An Effect that sends and records the email or fails with a typed error.
 */
export const deliver = (
  env: WorkerEnv,
  claimToken: string,
  deliveryId: string,
  announcementId: string
) =>
  Effect.gen(function* deliverEffect() {
    const delivery = yield* d1(() =>
      env.DB.prepare(
        "SELECT id, announcement_id, recipient, status, idempotency_key FROM deliveries WHERE id = ? AND announcement_id = ?"
      )
        .bind(deliveryId, announcementId)
        .first<DeliveryState>()
    );
    if (
      !delivery ||
      delivery.status === "sent" ||
      delivery.status === "failed"
    ) {
      return;
    }
    const row = yield* d1(() =>
      env.DB.prepare(
        "SELECT normalized_payload, source_guild_id, source_channel_id, source_message_id, follower_webhook_id, subscription_id FROM announcements WHERE id = ?"
      )
        .bind(announcementId)
        .first<AnnouncementRow>()
    );
    if (!row) {
      return yield* Effect.fail(
        new BridgeInfrastructureError(
          "load_announcement",
          "delivery references missing announcement"
        )
      );
    }
    const message = yield* Schema.decodeUnknownEffect(StoredMessageSchema)(
      row.normalized_payload
    ).pipe(
      Effect.mapError(
        () =>
          new BridgeInfrastructureError(
            "decode_announcement",
            "invalid stored message"
          )
      )
    );
    const announcement: Announcement = {
      followerWebhookId: row.follower_webhook_id,
      message,
      sourceChannelId: row.source_channel_id,
      sourceGuildId: row.source_guild_id,
      sourceMessageId: row.source_message_id,
      subscriptionId: row.subscription_id,
    };
    if (!env.EMAIL_FROM_NAME.trim() || !env.EMAIL_FROM_EMAIL.trim()) {
      return yield* Effect.fail(
        new ApiError("Email sender configuration is incomplete", 500, false)
      );
    }
    const response = yield* sendEmail(
      env,
      {
        from: emailSender(env.EMAIL_FROM_NAME, env.EMAIL_FROM_EMAIL),
        html: renderHtml(announcement),
        subject: emailSubject(announcement),
        text: renderText(announcement),
        to: [delivery.recipient],
      },
      delivery.idempotency_key
    );
    const markedSent = yield* d1(() =>
      env.DB.prepare(
        "UPDATE deliveries SET status = 'sent', resend_email_id = ?, attempts = attempts + 1, claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP, sent_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ? AND status != 'sent' AND claim_token = ? RETURNING id"
      )
        .bind(response.id, delivery.id, claimToken)
        .first<DeliveryIdRow>()
    );
    if (!markedSent) {
      return yield* Effect.fail(
        new BridgeInfrastructureError(
          "complete_delivery",
          "delivery claim expired before completion",
          true
        )
      );
    }
    yield* Effect.logInfo("delivery.sent", {
      resendEmailId: response.id,
    });
  });

/** Persisted delivery states that are valid when a delivery is loaded. */
type DeliveryStatus = "pending" | "queued" | "sent" | "failed";
/** D1 row shape required before rendering and sending a delivery. */
interface DeliveryState {
  readonly id: string;
  readonly recipient: string;
  readonly status: DeliveryStatus;
  readonly idempotency_key: string;
}
/** Minimal D1 result proving a token-guarded sent update succeeded. */
interface DeliveryIdRow {
  readonly id: string;
}
/** D1 announcement fields required to reconstruct the email domain object. */
interface AnnouncementRow {
  readonly normalized_payload: string;
  readonly source_guild_id: string;
  readonly source_channel_id: string;
  readonly source_message_id: string;
  readonly follower_webhook_id: string;
  readonly subscription_id: string;
}
export { ApiError } from "@/application/delivery-error";
