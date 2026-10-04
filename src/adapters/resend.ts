import {
  fromApiKey,
  ResendProtocol,
  Retry,
  Services,
} from "@distilled.cloud/resend";
import { Effect, Layer, Schema } from "effect";
import { layer as fetchLayer } from "effect/http/FetchHttpClient";
import { HttpClient, mapRequest } from "effect/http/HttpClient";
import { setHeader } from "effect/http/HttpClientRequest";

import type { WorkerEnv } from "@/alchemy.run";
import { ApiError } from "@/application/delivery-error";

export interface EmailPayload {
  readonly from: string;
  readonly html: string;
  readonly subject: string;
  readonly text: string;
  readonly to: readonly string[];
}

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

const ResendFailureSchema = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

const toResendApiError = (cause: unknown): ApiError => {
  if (cause instanceof ApiError) {
    return cause;
  }
  const parsed = Schema.decodeUnknownOption(ResendFailureSchema)(cause);
  const tag = parsed._tag === "Some" ? parsed.value._tag : undefined;
  const mappedStatus = tag ? errorStatuses.get(tag) : undefined;
  const status = tag === "HttpClientError" ? 503 : (mappedStatus ?? 502);
  const retryableStatus =
    status === 408 || status === 409 || status === 423 || status === 429;
  const retryable =
    tag === "HttpClientError" ||
    tag === "ResendParseError" ||
    retryableStatus ||
    status >= 500;
  return new ApiError(
    `Resend request failed (HTTP ${status})`,
    status,
    retryable
  );
};

const idempotencyHttpClientLayer = (idempotencyKey: string) =>
  Layer.effect(
    HttpClient,
    HttpClient.pipe(
      Effect.map((client) =>
        mapRequest((request) => {
          if (
            request.method === "POST" &&
            new URL(request.url).pathname === "/emails"
          ) {
            return setHeader(request, "Idempotency-Key", idempotencyKey);
          }
          return request;
        })(client)
      )
    )
  ).pipe(Layer.provide(fetchLayer));

const resendLayer = (env: WorkerEnv, idempotencyKey: string) =>
  Layer.mergeAll(
    fromApiKey({ apiKey: env.RESEND_API_KEY }),
    ResendProtocol,
    idempotencyHttpClientLayer(idempotencyKey)
  );

/** Send an email through Distilled Resend with stable request idempotency. */
export const sendEmail = (
  env: WorkerEnv,
  payload: EmailPayload,
  idempotencyKey: string
): Effect.Effect<{ readonly id: string }, ApiError> => {
  if (!env.RESEND_API_KEY) {
    return Effect.fail(
      new ApiError("Resend configuration is incomplete", 500, false)
    );
  }
  return Services.resend.createEmail({ ...payload, to: [...payload.to] }).pipe(
    Effect.flatMap((response) => {
      if (!response.id?.trim()) {
        return Effect.fail(
          new ApiError("Resend response was missing an email ID", 502, true)
        );
      }
      return Effect.succeed({ id: response.id });
    }),
    Retry.none,
    Effect.mapError(toResendApiError),
    Effect.provide(resendLayer(env, idempotencyKey)),
    Effect.timeout("60 seconds"),
    Effect.mapError(toResendApiError)
  );
};
