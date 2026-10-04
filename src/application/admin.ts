import { Cause, Effect, Redacted } from "effect";

import { d1, ensureSubscription } from "@/adapters/d1";
import type { WorkerEnv } from "@/alchemy.run";
import { BridgeInfrastructureError } from "@/bridge-infrastructure-error";

/** Minimal success contract shared by poll orchestration and admin routes. */
interface PollResult {
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Build the non-sensitive health payload exposed to platform probes.
 * @param env - Build and stage bindings exposed by the health response.
 * @returns A JSON response containing safe health metadata.
 */
export const healthResponse = (
  env: Pick<WorkerEnv, "BUILD_VERSION" | "STAGE">
) =>
  Response.json({
    stage: env.STAGE ?? "local",
    status: "ok",
    version: env.BUILD_VERSION ?? "development",
  });

/**
 * Validate a Bearer token using fixed-length SHA-256 digests and a
 * timing-safe comparison to avoid leaking token matches through timing.
 * @param request - Request whose Authorization header is checked.
 * @param token - Expected bearer token.
 * @returns Whether the supplied non-empty token matches.
 */
export const authorized = async (
  request: Request,
  token: string
): Promise<boolean> => {
  const supplied =
    request.headers.get("authorization")?.replace(/^Bearer\s+/iu, "") ?? "";
  const expected = Redacted.value(Redacted.make(token));
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(supplied)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
  ]);
  return (
    crypto.subtle.timingSafeEqual(
      new Uint8Array(left),
      new Uint8Array(right)
    ) && supplied.length > 0
  );
};

/**
 * Run one poll and translate its outcome into the admin HTTP response.
 * @param env - Worker bindings passed to the poll operation.
 * @param runPoll - Poll implementation to invoke.
 * @returns An accepted or unavailable HTTP response.
 */
const pollResponse = async (
  env: WorkerEnv,
  runPoll: (env: WorkerEnv) => Promise<PollResult>
): Promise<Response> => {
  const result = await runPoll(env);
  return result.ok
    ? Response.json({ status: "accepted" }, { status: 202 })
    : Response.json({ error: "poll_failed" }, { status: 503 });
};

/**
 * Route authorized admin operations for polling, replay, and delivery status.
 * Unknown paths and methods return a 404 without exposing internal failures.
 * @param method - HTTP method of the request.
 * @param pathname - Request path to route.
 * @param env - Worker bindings for the selected operation.
 * @param runPoll - Poll implementation used by poll and replay routes.
 * @returns The response for the matched route or a 404 response.
 */
export const adminResponse = async (
  method: string,
  pathname: string,
  env: WorkerEnv,
  runPoll: (env: WorkerEnv) => Promise<PollResult>
): Promise<Response> => {
  if (method === "POST" && pathname === "/admin/poll") {
    return pollResponse(env, runPoll);
  }
  if (method === "POST" && pathname === "/admin/replay") {
    const reset = await Effect.runPromiseExit(
      d1(() =>
        env.DB.prepare(
          "UPDATE deliveries SET status = 'pending', last_error = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE status = 'failed'"
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
  if (method === "GET" && pathname === "/admin/status") {
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
  return new Response("Not Found", { status: 404 });
};

/**
 * Build a subscription from required Worker bindings, if fully configured.
 * @param env - Worker bindings containing subscription configuration.
 * @returns The configured subscription, or `undefined` when required values are absent.
 */
export const subscriptionFromEnv = (env: WorkerEnv) => {
  if (
    !env.DISCORD_GUILD_ID ||
    !env.DISCORD_TARGET_CHANNEL_ID ||
    !env.EMAIL_TO
  ) {
    return;
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
};

/**
 * Persist the active environment-derived subscription before polling.
 * @param env - Worker bindings including D1.
 * @param subscription - Fully configured subscription to persist.
 * @returns The D1 operation result as a success or failure Exit.
 */
export const seedSubscription = (
  env: WorkerEnv,
  subscription: NonNullable<ReturnType<typeof subscriptionFromEnv>>
) => Effect.runPromiseExit(ensureSubscription(env, subscription));

/**
 * Produce a bounded error string without serializing secrets or arbitrary
 * objects from failed Effects.
 * @param cause - Failure cause returned by an Effect.
 * @returns A sanitized diagnostic string limited to 300 characters.
 */
export const safeError = (cause: Cause.Cause<unknown>): string => {
  const failure = Cause.findErrorOption(cause);
  if (failure._tag === "Some") {
    if (failure.value instanceof BridgeInfrastructureError) {
      return failure.value.message.slice(0, 300);
    }
    if (failure.value instanceof Error) {
      return failure.value.message.slice(0, 300);
    }
  }
  return Cause.pretty(cause).slice(0, 300);
};

/** D1 aggregate row used by the admin delivery status endpoint. */
interface StatusRow {
  readonly last_poll: string | null;
  readonly pending: number;
  readonly failed: number;
}
