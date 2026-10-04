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

const discordLayer = (env: WorkerEnv) =>
  Layer.mergeAll(
    fetchLayer,
    credentials({ token: env.DISCORD_BOT_TOKEN, tokenType: "Bot" }),
    DiscordProtocol
  );

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

/** Create Discord polling ports using the Effect-native Discord SDK. */
export const makeDiscordSource = (env: WorkerEnv) => ({
  fetchAfter: (channelId: string, after: string) =>
    messages(env, channelId, { after }),
  fetchBefore: (channelId: string, before: string) =>
    messages(env, channelId, { before }),
  fetchLatest: (channelId: string) => messages(env, channelId, {}),
  getWebhook: (webhookId: string) => webhook(env, webhookId),
});

export type DiscordSource = ReturnType<typeof makeDiscordSource>;
