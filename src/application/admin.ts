import { Cause, Effect, Redacted } from "effect";

import { d1, ensureSubscription } from "@/adapters/d1";
import type { WorkerEnv } from "@/alchemy.run";
import { BridgeInfrastructureError } from "@/bridge-infrastructure-error";

interface PollResult {
  readonly ok: boolean;
  readonly error?: string;
}

export const healthResponse = (env: WorkerEnv) =>
  Response.json({
    stage: env.STAGE ?? "local",
    status: "ok",
    version: env.BUILD_VERSION ?? "development",
  });

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

const pollResponse = async (
  env: WorkerEnv,
  runPoll: (env: WorkerEnv) => Promise<PollResult>
): Promise<Response> => {
  const result = await runPoll(env);
  return result.ok
    ? Response.json({ status: "accepted" }, { status: 202 })
    : Response.json({ error: "poll_failed" }, { status: 503 });
};

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

export const seedSubscription = (
  env: WorkerEnv,
  subscription: NonNullable<ReturnType<typeof subscriptionFromEnv>>
) => Effect.runPromiseExit(ensureSubscription(env, subscription));

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

interface StatusRow {
  readonly last_poll: string | null;
  readonly pending: number;
  readonly failed: number;
}
