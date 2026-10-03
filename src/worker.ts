import { Cause, Effect, Redacted, Schema } from "effect";

import type { WorkerEnv } from "../alchemy.run";
import {
  BridgeInfrastructureError,
  DiscordApiError,
  pollingServiceLayer,
  pollAll,
} from "./application";
import type { PollingPorts, UnparsedDiscordMessage } from "./application";
import {
  MessageSchema,
  idempotencyKey,
  renderHtml,
  renderText,
  WebhookSchema,
} from "./domain";
import type { Announcement, Subscription } from "./domain";

const QueuePayloadSchema = Schema.Struct({
  announcementId: Schema.String,
  deliveryId: Schema.String,
});

const ApiErrorSchema = Schema.Struct({
  message: Schema.String,
  retryable: Schema.Boolean,
  status: Schema.Number,
});

type ApiError = typeof ApiErrorSchema.Type;

const ResendResponseSchema = Schema.Struct({ id: Schema.String });
const StoredMessageSchema = Schema.fromJsonString(MessageSchema);

interface ResendEmailPayload {
  readonly from: string;
  readonly html: string;
  readonly subject: string;
  readonly text: string;
  readonly to: readonly string[];
}

/** Cloudflare Worker request, cron, and queue entrypoints. */
const worker = {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return healthResponse(env);
    }
    if (!url.pathname.startsWith("/admin/")) {
      return notFoundResponse();
    }
    if (!(await authorized(request, Redacted.make(env.ADMIN_TOKEN)))) {
      return new Response("Unauthorized", { status: 401 });
    }
    return adminResponse(request.method, url.pathname, env);
  },

  async queue(batch: MessageBatch<unknown>, env: WorkerEnv): Promise<void> {
    if (batch.queue === env.DELIVERY_DEAD_LETTER_QUEUE_NAME) {
      for (const message of batch.messages) {
        const payload = Schema.decodeUnknownOption(QueuePayloadSchema)(
          message.body
        );
        if (payload._tag === "None") {
          console.error(JSON.stringify({ event: "queue.invalid_dead_letter" }));
          continue;
        }
        await Effect.runPromise(
          markDeadLetterFailure(env.DB, payload.value.deliveryId)
        );
        console.error(
          JSON.stringify({
            deliveryId: payload.value.deliveryId,
            event: "delivery.dead_lettered",
          })
        );
      }
      return;
    }
    for (const message of batch.messages) {
      const payloadOption = Schema.decodeUnknownOption(QueuePayloadSchema)(
        message.body
      );
      if (payloadOption._tag === "None") {
        console.error(JSON.stringify({ event: "queue.invalid_message" }));
        continue;
      }
      const payload = payloadOption.value;
      const result = await Effect.runPromiseExit(
        deliver(env, payload.deliveryId, payload.announcementId)
      );
      if (result._tag === "Failure") {
        const errorMessage = safeError(result.cause);
        const retryable = isRetryable(result.cause);
        const recorded = await Effect.runPromiseExit(
          recordDeliveryFailure(
            env.DB,
            payload.deliveryId,
            errorMessage,
            retryable
          )
        );
        if (recorded._tag === "Failure") {
          throw Cause.squash(recorded.cause);
        }
        if (retryable) {
          console.warn(
            JSON.stringify({
              event: "delivery.retry",
              deliveryId: payload.deliveryId,
              attempt: message.attempts,
              error: errorMessage,
            })
          );
          throw Cause.squash(result.cause);
        }
        console.error(
          JSON.stringify({
            event: "delivery.failed",
            deliveryId: payload.deliveryId,
            error: errorMessage,
          })
        );
      }
    }
  },

  async scheduled(
    _controller: ScheduledController,
    env: WorkerEnv
  ): Promise<void> {
    const result = await runPoll(env);
    if (!result.ok) {
      console.error(
        JSON.stringify({ event: "cron.failed", error: result.error })
      );
    }
  },
};

export default worker;

function healthResponse(env: WorkerEnv): Response {
  return Response.json({
    status: "ok",
    version: env.BUILD_VERSION ?? "development",
    stage: env.STAGE ?? "local",
  });
}

function notFoundResponse(): Response {
  return new Response("Not Found", { status: 404 });
}

function adminResponse(
  method: string,
  pathname: string,
  env: WorkerEnv
): Promise<Response> {
  if (method === "POST" && pathname === "/admin/poll") {
    return pollResponse(env);
  }
  if (method === "POST" && pathname === "/admin/replay") {
    return replayResponse(env);
  }
  if (method === "GET" && pathname === "/admin/status") {
    return statusResponse(env);
  }
  return Promise.resolve(notFoundResponse());
}

async function pollResponse(env: WorkerEnv): Promise<Response> {
  const result = await runPoll(env);
  return result.ok
    ? Response.json({ status: "accepted" }, { status: 202 })
    : Response.json({ error: "poll_failed" }, { status: 503 });
}

async function replayResponse(env: WorkerEnv): Promise<Response> {
  const reset = await Effect.runPromiseExit(
    d1(() =>
      env.DB.prepare(
        "UPDATE deliveries SET status = 'pending', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'failed'"
      ).run()
    )
  );
  if (reset._tag === "Failure") {
    return Response.json({ error: "replay_failed" }, { status: 503 });
  }
  const result = await runPoll(env);
  return result.ok
    ? Response.json({ status: "replay_queued" }, { status: 202 })
    : Response.json({ error: "replay_failed" }, { status: 503 });
}

async function runPoll(
  env: WorkerEnv
): Promise<
  { readonly ok: true } | { readonly ok: false; readonly error: string }
> {
  const config = subscriptionFromEnv(env);
  if (!config) {
    return { ok: false, error: "required_configuration_missing" };
  }
  const seed = await Effect.runPromiseExit(ensureSubscription(env.DB, config));
  if (seed._tag === "Failure") {
    return { ok: false, error: safeError(seed.cause) };
  }
  const ports = createPollingPorts(env);
  const result = await Effect.runPromiseExit(
    pollAll.pipe(Effect.provide(pollingServiceLayer(ports)))
  );
  return result._tag === "Success"
    ? { ok: true }
    : { error: safeError(result.cause), ok: false };
}

function subscriptionFromEnv(env: WorkerEnv): Subscription | undefined {
  if (
    !env.DISCORD_GUILD_ID ||
    !env.DISCORD_TARGET_CHANNEL_ID ||
    !env.EMAIL_TO
  ) {
    return undefined;
  }
  return {
    destinationChannelId: env.DISCORD_TARGET_CHANNEL_ID,
    destinationGuildId: env.DISCORD_GUILD_ID,
    emailTo: env.EMAIL_TO,
    id: env.DISCORD_TARGET_CHANNEL_ID,
    ...(env.SOURCE_GUILD_ID
      ? { sourceGuildId: env.SOURCE_GUILD_ID }
      : undefined),
    ...(env.SOURCE_CHANNEL_ID
      ? { sourceChannelId: env.SOURCE_CHANNEL_ID }
      : undefined),
  };
}

function createPollingPorts(env: WorkerEnv): PollingPorts {
  return {
    enqueue: (delivery) =>
      Effect.tryPromise({
        try: () => env.DELIVERY_QUEUE.send(delivery),
        catch: (cause) => infrastructureError("queue_send", cause),
      }).pipe(Effect.asVoid),
    repository: {
      cursor: (subscriptionId) =>
        d1(() =>
          env.DB.prepare(
            "SELECT last_message_id FROM channel_cursors WHERE subscription_id = ?"
          )
            .bind(subscriptionId)
            .first<CursorRow>()
        ).pipe(
          Effect.map((row) => (row ? (row.last_message_id ?? "0") : undefined))
        ),
      enabledSubscriptions: () =>
        d1(() =>
          env.DB.prepare(
            "SELECT id, destination_guild_id, destination_channel_id, source_guild_id, source_channel_id, email_to FROM subscriptions WHERE enabled = 1"
          ).all<SubscriptionRow>()
        ).pipe(Effect.map((result) => result.results.map(toSubscription))),
      initializeCursor: (subscriptionId, messageId) =>
        d1(() =>
          env.DB.prepare(
            "INSERT INTO channel_cursors (subscription_id, last_message_id) VALUES (?, ?) ON CONFLICT(subscription_id) DO NOTHING"
          )
            .bind(subscriptionId, messageId ?? null)
            .run()
        ).pipe(Effect.asVoid),
      markEnqueued: (deliveryId) =>
        d1(() =>
          env.DB.prepare(
            "UPDATE deliveries SET status = 'queued', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'"
          )
            .bind(deliveryId)
            .run()
        ).pipe(Effect.asVoid),
      pendingDeliveries: (subscriptionId) =>
        d1(() =>
          env.DB.prepare(
            "SELECT d.id AS delivery_id, d.announcement_id FROM deliveries d JOIN announcements a ON a.id = d.announcement_id WHERE a.subscription_id = ? AND d.status = 'pending' ORDER BY d.created_at LIMIT 500"
          )
            .bind(subscriptionId)
            .all<DeliveryRow>()
        ).pipe(
          Effect.map((result) =>
            result.results.map((row) => ({
              deliveryId: row.delivery_id,
              announcementId: row.announcement_id,
            }))
          )
        ),
      persistDiscoveryBatch: (subscription, announcements, cursor) =>
        persistBatch(env, subscription, announcements, cursor),
    },
    source: {
      fetchAfter: (channelId, after) =>
        discordMessages(env, channelId, { after }),
      fetchBefore: (channelId, before) =>
        discordMessages(env, channelId, { before }),
      fetchLatest: (channelId) => discordMessages(env, channelId, {}),
      getWebhook: (webhookId) =>
        discordGet(
          env,
          `/webhooks/${encodeURIComponent(webhookId)}`,
          WebhookSchema
        ).pipe(
          Effect.catchIf(
            (error) => error.status === 404,
            () => Effect.succeed<undefined>(undefined)
          )
        ),
    },
  };
}

function discordMessages(
  env: WorkerEnv,
  channelId: string,
  pagination: { readonly after?: string; readonly before?: string }
): Effect.Effect<readonly UnparsedDiscordMessage[], DiscordApiError> {
  const query = new URLSearchParams({ limit: "100" });
  if (pagination.after) {
    query.set("after", pagination.after);
  }
  if (pagination.before) {
    query.set("before", pagination.before);
  }
  return discordGet(
    env,
    `/channels/${encodeURIComponent(channelId)}/messages?${query.toString()}`,
    Schema.Array(Schema.Unknown)
  ).pipe(Effect.map((messages) => messages.map((raw) => ({ raw }))));
}

function discordGet<T>(
  env: WorkerEnv,
  path: string,
  schema: Schema.ConstraintDecoder<T, never>
): Effect.Effect<T, DiscordApiError> {
  return Effect.tryPromise({
    catch: (cause) => {
      if (cause instanceof Schema.SchemaError) {
        return discordError("Discord returned an invalid response", 502, false);
      }
      if (isDiscordApiError(cause)) {
        return cause;
      }
      return discordError("Discord REST request failed", 503, true);
    },
    try: async () => {
      if (!env.DISCORD_BOT_TOKEN) {
        throw discordError("Discord bot token is not configured", 500, false);
      }
      const response = await fetch(`https://discord.com/api/v10${path}`, {
        headers: {
          Authorization: `Bot ${Redacted.value(Redacted.make(env.DISCORD_BOT_TOKEN))}`,
        },
      });
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw discordError(
          `Discord REST returned ${response.status}`,
          response.status,
          retryable
        );
      }
      const payload: unknown = await response.json();
      return Schema.decodeUnknownSync(schema)(payload);
    },
  });
}

function persistBatch(
  env: WorkerEnv,
  subscription: Subscription,
  announcements: readonly Announcement[],
  cursor: string | undefined
) {
  return Effect.gen(function* persistBatchEffect() {
    const statements: D1PreparedStatement[] = [];
    for (const announcement of announcements) {
      const announcementId = `${subscription.id}:${announcement.message.id}`;
      const deliveryId = `${announcementId}:${subscription.emailTo.toLowerCase()}`;
      const key = yield* idempotencyKey(
        announcement,
        subscription.emailTo
      ).pipe(
        Effect.mapError((cause) =>
          infrastructureError("idempotency_key", cause)
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
          infrastructureError("persist_discovery", "D1 batch failed")
        );
      }
    }
  });
}

function deliver(env: WorkerEnv, deliveryId: string, announcementId: string) {
  return Effect.gen(function* deliverEffect() {
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
    const announcementRow = yield* d1(() =>
      env.DB.prepare(
        "SELECT normalized_payload, source_guild_id, source_channel_id, source_message_id, follower_webhook_id, subscription_id FROM announcements WHERE id = ?"
      )
        .bind(announcementId)
        .first<AnnouncementRow>()
    );
    if (!announcementRow) {
      return yield* Effect.fail(
        infrastructureError(
          "load_announcement",
          "delivery references missing announcement"
        )
      );
    }
    const message = yield* Schema.decodeUnknownEffect(StoredMessageSchema)(
      announcementRow.normalized_payload
    ).pipe(
      Effect.mapError(() =>
        infrastructureError("decode_announcement", "invalid stored message")
      )
    );
    const announcement: Announcement = {
      followerWebhookId: announcementRow.follower_webhook_id,
      message,
      sourceChannelId: announcementRow.source_channel_id,
      sourceGuildId: announcementRow.source_guild_id,
      sourceMessageId: announcementRow.source_message_id,
      subscriptionId: announcementRow.subscription_id,
    };
    const renderedHtml = renderHtml(announcement);
    const renderedText = renderText(announcement);
    const subject = emailSubject(announcement);
    const response = yield* resend(
      env,
      {
        from: emailSender(env.EMAIL_FROM_NAME, env.EMAIL_FROM_EMAIL),
        html: renderedHtml,
        subject,
        text: renderedText,
        to: [delivery.recipient],
      },
      delivery.idempotency_key
    );
    yield* d1(() =>
      env.DB.prepare(
        "UPDATE deliveries SET status = 'sent', resend_email_id = ?, attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP, sent_at = CURRENT_TIMESTAMP, last_error = NULL WHERE id = ? AND status != 'sent'"
      )
        .bind(response.id, delivery.id)
        .run()
    );
    yield* Effect.logInfo("delivery.sent", {
      deliveryId,
      resendEmailId: response.id,
    });
  });
}

function resend(
  env: WorkerEnv,
  payload: ResendEmailPayload,
  key: string
): Effect.Effect<{ readonly id: string }, ApiError> {
  return Effect.tryPromise({
    catch: (cause) =>
      isApiError(cause) ? cause : apiError("Resend request failed", 503, true),
    try: async () => {
      if (
        !env.RESEND_API_KEY ||
        !env.EMAIL_FROM_NAME.trim() ||
        !env.EMAIL_FROM_EMAIL.trim()
      ) {
        throw apiError("Resend configuration is incomplete", 500, false);
      }
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${Redacted.value(Redacted.make(env.RESEND_API_KEY))}`,
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(payload),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        const retryable =
          response.status === 409 ||
          response.status === 429 ||
          response.status >= 500;
        const error = apiError(
          retryable
            ? "Resend temporarily rejected the request"
            : "Resend rejected the request",
          response.status,
          retryable
        );
        throw error;
      }
      const parsed = Schema.decodeUnknownOption(ResendResponseSchema)(body);
      if (parsed._tag === "None") {
        throw apiError("Resend response was missing an email ID", 502, true);
      }
      return parsed.value;
    },
  });
}

function ensureSubscription(db: D1Database, subscription: Subscription) {
  return d1(() =>
    db.batch([
      db
        .prepare(
          "INSERT INTO subscriptions (id, destination_guild_id, destination_channel_id, source_guild_id, source_channel_id, email_to, enabled) VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(id) DO UPDATE SET destination_guild_id = excluded.destination_guild_id, destination_channel_id = excluded.destination_channel_id, source_guild_id = excluded.source_guild_id, source_channel_id = excluded.source_channel_id, email_to = excluded.email_to, enabled = 1, updated_at = CURRENT_TIMESTAMP"
        )
        .bind(
          subscription.id,
          subscription.destinationGuildId,
          subscription.destinationChannelId,
          subscription.sourceGuildId ?? null,
          subscription.sourceChannelId ?? null,
          subscription.emailTo
        ),
      db
        .prepare(
          "INSERT INTO channel_cursors (subscription_id, last_message_id) VALUES (?, NULL) ON CONFLICT(subscription_id) DO NOTHING"
        )
        .bind(subscription.id),
    ])
  ).pipe(Effect.asVoid);
}

function statusResponse(env: WorkerEnv): Promise<Response> {
  return Effect.runPromise(
    d1(() =>
      env.DB.prepare(
        "SELECT (SELECT MAX(updated_at) FROM channel_cursors) AS last_poll, (SELECT COUNT(*) FROM deliveries WHERE status = 'pending') AS pending, (SELECT COUNT(*) FROM deliveries WHERE status = 'failed') AS failed"
      ).first<StatusRow>()
    ).pipe(
      Effect.match({
        onFailure: () =>
          Response.json({ error: "status_unavailable" }, { status: 503 }),
        onSuccess: (row) =>
          Response.json({
            failedDeliveries: row?.failed ?? 0,
            lastPoll: row?.last_poll ?? null,
            pendingDeliveries: row?.pending ?? 0,
          }),
      })
    )
  );
}

async function authorized(
  request: Request,
  expected: Redacted.Redacted<string>
): Promise<boolean> {
  const supplied =
    request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
    crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(Redacted.value(expected))
    ),
  ]);
  const a = new Uint8Array(left);
  const b = new Uint8Array(right);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0 && supplied.length > 0;
}

function d1<A>(
  operation: () => Promise<A>
): Effect.Effect<A, BridgeInfrastructureError> {
  return Effect.tryPromise({
    catch: (cause) => infrastructureError("d1", cause),
    try: operation,
  });
}

function recordDeliveryFailure(
  db: D1Database,
  deliveryId: string,
  error: string,
  retryable: boolean
) {
  return d1(() =>
    db
      .prepare(
        "UPDATE deliveries SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'sent'"
      )
      .bind(retryable ? "queued" : "failed", error.slice(0, 500), deliveryId)
      .run()
  ).pipe(Effect.asVoid);
}

function markDeadLetterFailure(db: D1Database, deliveryId: string) {
  return d1(() =>
    db
      .prepare(
        "UPDATE deliveries SET status = 'failed', last_error = 'queue_retry_exhausted', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'sent'"
      )
      .bind(deliveryId)
      .run()
  ).pipe(Effect.asVoid);
}

function emailSubject(announcement: Announcement): string {
  const title = announcement.message.embeds.find((embed) => embed.title)?.title;
  const safeTitle = (title ?? announcement.message.content)
    .replaceAll(/[\r\n]+/gu, " ")
    .trim()
    .slice(0, 100);
  return safeTitle
    ? `[Discord] Announcement — ${safeTitle}`.slice(0, 150)
    : "[Discord] New announcement";
}

function emailSender(name: string, address: string): string {
  const safeName = name.trim().replaceAll(/[\r\n]+/gu, " ");
  return `${safeName} <${address.trim()}>`;
}

function apiError(
  message: string,
  status: number,
  retryable: boolean
): ApiError {
  return { message, retryable, status };
}

function discordError(
  message: string,
  status: number,
  retryable: boolean
): DiscordApiError {
  return new DiscordApiError(message, status, retryable);
}

function infrastructureError(
  operation: string,
  cause: unknown
): BridgeInfrastructureError {
  return new BridgeInfrastructureError(operation, cause);
}

function isApiError(error: unknown): error is ApiError {
  return Schema.is(ApiErrorSchema)(error);
}

function isDiscordApiError(error: unknown): error is DiscordApiError {
  return error instanceof DiscordApiError;
}

function isRetryable(cause: Cause.Cause<unknown>): boolean {
  const failure = Cause.findErrorOption(cause);
  if (failure._tag === "None") {
    return false;
  }
  if (failure.value instanceof DiscordApiError) {
    return failure.value.retryable;
  }
  const parsed = Schema.decodeUnknownOption(ApiErrorSchema)(failure.value);
  return parsed._tag === "Some" && parsed.value.retryable;
}

function safeError(cause: Cause.Cause<unknown>): string {
  return Cause.pretty(cause).slice(0, 300);
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    destinationChannelId: row.destination_channel_id,
    destinationGuildId: row.destination_guild_id,
    emailTo: row.email_to,
    id: row.id,
    ...(row.source_guild_id
      ? { sourceGuildId: row.source_guild_id }
      : undefined),
    ...(row.source_channel_id
      ? { sourceChannelId: row.source_channel_id }
      : undefined),
  };
}

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
interface DeliveryState {
  readonly id: string;
  readonly announcement_id: string;
  readonly recipient: string;
  readonly status: "pending" | "sent" | "failed";
  readonly idempotency_key: string;
}
interface AnnouncementRow {
  readonly normalized_payload: string;
  readonly source_guild_id: string;
  readonly source_channel_id: string;
  readonly source_message_id: string;
  readonly follower_webhook_id: string;
  readonly subscription_id: string;
}
interface StatusRow {
  readonly last_poll: string | null;
  readonly pending: number;
  readonly failed: number;
}
