import {
  credentials,
  DiscordProtocol,
  Retry,
  Services,
} from "@distilled.cloud/discord";
import { Effect, Layer, Schema } from "effect";
import { layer as fetchLayer } from "effect/http/FetchHttpClient";

import type { WorkerEnv } from "@/alchemy.run";
import type { UnparsedDiscordMessage } from "@/application/polling";
import { DiscordApiError } from "@/discord-api-error";
import { WebhookSchema } from "@/domain";
import type { FollowerWebhook } from "@/domain";

export type { FollowerWebhook } from "@/domain";

/** Map SDK error tags to HTTP status codes for retry classification. */
const errorStatuses = new Map([
  ["BadGateway", 502],
  ["BadRequest", 400],
  ["Conflict", 409],
  ["Forbidden", 403],
  ["GatewayTimeout", 504],
  ["InternalServerError", 500],
  ["Locked", 423],
  ["NotFound", 404],
  ["ServiceUnavailable", 503],
  ["TooManyRequests", 429],
  ["Unauthorized", 401],
  ["UnprocessableEntity", 422],
]);

/**
 * Convert SDK failures into sanitized Discord errors with retry metadata.
 * @param cause - Unknown failure returned by the Discord SDK.
 * @returns A sanitized API error with status and retry classification.
 */
const toDiscordApiError = (cause: unknown): DiscordApiError => {
  if (cause instanceof DiscordApiError) {
    return cause;
  }
  const error = Schema.decodeUnknownOption(
    Schema.Struct({
      _tag: Schema.String,
    })
  )(cause);
  const status =
    error._tag === "Some" ? errorStatuses.get(error.value._tag) : undefined;
  const safeStatus = status ?? 502;
  const retryable =
    safeStatus === 408 ||
    safeStatus === 423 ||
    safeStatus === 429 ||
    safeStatus >= 500;
  return new DiscordApiError(
    `Discord REST request failed (HTTP ${safeStatus})`,
    safeStatus,
    retryable
  );
};

/**
 * Compose the fetch, bot credential, and Discord protocol layers.
 * @param env - Worker bindings containing the Discord bot token.
 * @returns A merged Effect layer for Discord REST operations.
 */
const discordLayer = (env: WorkerEnv) =>
  Layer.mergeAll(
    fetchLayer,
    credentials({ token: env.DISCORD_BOT_TOKEN, tokenType: "Bot" }),
    DiscordProtocol
  );

/**
 * Fetch one Discord message page without SDK retries or eager decoding.
 * @param env - Worker bindings containing the Discord bot token.
 * @param channelId - Destination channel to read.
 * @param pagination - Optional exclusive pagination boundary.
 * @returns An Effect containing raw message payloads or a Discord API error.
 */
const messages = (
  env: WorkerEnv,
  channelId: string,
  pagination: { readonly after?: string; readonly before?: string }
): Effect.Effect<readonly UnparsedDiscordMessage[], DiscordApiError> =>
  Services.discord
    .listMessages({
      channel_id: channelId,
      limit: 100,
      ...pagination,
    })
    .pipe(
      Retry.none,
      Effect.map((result) => result.map((raw) => ({ raw }))),
      Effect.mapError(toDiscordApiError),
      Effect.provide(discordLayer(env))
    );

/**
 * Fetch and validate webhook metadata; represent missing webhooks as null.
 * @param env - Worker bindings containing the Discord bot token.
 * @param webhookId - Webhook identifier to retrieve.
 * @returns An Effect containing validated metadata, `null` when missing, or an API error.
 */
const webhook = (
  env: WorkerEnv,
  webhookId: string
): Effect.Effect<FollowerWebhook | null, DiscordApiError> =>
  Services.discord.getWebhook({ webhook_id: webhookId }).pipe(
    Retry.none,
    Effect.flatMap((result) =>
      Schema.decodeUnknownEffect(WebhookSchema)(result).pipe(
        Effect.mapError(
          () =>
            new DiscordApiError(
              "Discord returned an invalid webhook response",
              502,
              false
            )
        )
      )
    ),
    Effect.mapError(toDiscordApiError),
    Effect.catchIf(
      (error) => error.status === 404,
      () => Effect.succeed(null)
    ),
    Effect.provide(discordLayer(env))
  );

/**
 * Create polling ports bound to the supplied Worker's bot credentials.
 * Returned methods expose page-based message reads and validated webhook reads.
 * @param env - Worker bindings containing the Discord bot token.
 * @returns Discord source operations bound to these credentials.
 */
export const makeDiscordSource = (env: WorkerEnv) => ({
  fetchAfter: (channelId: string, after: string) =>
    messages(env, channelId, { after }),
  fetchBefore: (channelId: string, before: string) =>
    messages(env, channelId, { before }),
  fetchLatest: (channelId: string) => messages(env, channelId, {}),
  getWebhook: (webhookId: string) => webhook(env, webhookId),
});

/** Type of the Discord polling adapter returned by {@link makeDiscordSource}. */
