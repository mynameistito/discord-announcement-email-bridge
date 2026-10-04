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

/** Content and recipient fields accepted by the Resend email endpoint. */
export interface EmailPayload {
  /** Validated sender display name and mailbox formatted as a From value. */
  readonly from: string;
  /** Sanitized HTML rendering of the announcement. */
  readonly html: string;
  /** Bounded subject derived from the announcement. */
  readonly subject: string;
  /** Plain-text rendering supplied as an accessible fallback. */
  readonly text: string;
  /** One or more destination email addresses. */
  readonly to: readonly string[];
}

/** Map Resend SDK failure tags to HTTP status codes for retry decisions. */
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

/** Minimal SDK error fields inspected without exposing provider response data. */
const ResendFailureSchema = Schema.Struct({
  _tag: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
});

/**
 * Normalize provider failures and classify whether the queue should retry.
 * @param cause - Unknown failure returned by the Resend SDK.
 * @returns A sanitized API error with status and retry classification.
 */
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

/**
 * Add the stable idempotency header only to Resend email creation requests.
 * @param idempotencyKey - Stable key reused for retries of the same delivery.
 * @returns An HTTP client layer that adds the key to email creation requests.
 */
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

/**
 * Compose authenticated Resend and HTTP middleware layers for one send.
 * @param env - Worker binding containing the Resend API key.
 * @param idempotencyKey - Stable key to attach to email creation requests.
 * @returns A merged Effect layer for authenticated Resend requests.
 */
const resendLayer = (
  env: Pick<WorkerEnv, "RESEND_API_KEY">,
  idempotencyKey: string
) =>
  Layer.mergeAll(
    fromApiKey({ apiKey: env.RESEND_API_KEY }),
    ResendProtocol,
    idempotencyHttpClientLayer(idempotencyKey)
  );

/**
 * Send an email through Resend with a bounded request and stable idempotency.
 * @param env - The API-key binding required by the provider adapter.
 * @param payload - Fully rendered message fields and destination recipients.
 * @param idempotencyKey - Stable key retained across retries of this delivery.
 * @returns The provider email ID, or a classified API failure.
 */
export const sendEmail = (
  env: Pick<WorkerEnv, "RESEND_API_KEY">,
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
