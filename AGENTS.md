# PROJECT KNOWLEDGE BASE

**Generated:** 2026-10-05  
**Commit:** 3df9496  
**Branch:** main

## OVERVIEW

Bun 1.4.2, TypeScript, Effect 4, and Alchemy power a Cloudflare Worker that polls Discord follower channels, verifies announcement crossposts, persists discoveries in D1, and delivers mail through Queues and Resend.

## STRUCTURE

```text
src/                 Worker, domain, application services, and adapters
__tests__/           Unit/integration tests and live Discord E2E helpers
scripts/             E2E runner and GitHub Actions summary renderer
migrations/          Ordered D1 schema migrations
docs/                Configuration, development, deployment, operations, ADR
.github/workflows/   CI, deployment, and manually triggered live E2E
alchemy.run.ts       Alchemy resources, Worker bindings, queue consumers
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| HTTP, cron, and queue entry | `src/worker.ts`, `src/composition.ts` | Worker delegates to composed app/infrastructure operations |
| Crosspost verification and message model | `src/domain.ts` | Runtime schemas, follower webhook checks, snowflake ordering |
| Polling and delivery use cases | `src/application/` | Effect services orchestrate ports and typed failures |
| Discord, D1, Queue, and Resend integrations | `src/adapters/` | Translate external APIs and persistence to application contracts |
| Infrastructure and environment configuration | `alchemy.run.ts`, `src/resources.ts`, `src/stage-config.ts` | Alchemy resource definitions and stage-specific behavior |
| Database shape and evolution | `migrations/` | Append migrations; persisted status/claim logic must stay compatible |
| Tests | `__tests__/` | Vitest; database, worker, application, and adapter coverage |
| Live end-to-end workflow | `__tests__/e2e/`, `scripts/e2e.ts` | Sends real Discord posts and email; use isolated preview resources only |
| Operational behavior | `docs/operations.md`, `docs/adr/` | Admin endpoints, troubleshooting, delivery guarantees, architecture rationale |

## CODE MAP

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `worker` | Worker handler | `src/worker.ts` | Routes fetch, queue, and scheduled events |
| `poll` / `consumeQueue` | Composition functions | `src/composition.ts` | Bind Worker environment resources to use cases |
| `classifyFollowerMessage` | Domain function | `src/domain.ts` | Accept only verified follower crossposts matching subscription constraints |
| `pollAll` | Effect | `src/application/polling.ts` | Poll enabled subscriptions and aggregate failures |
| `deliver` | Effect | `src/application/delivery.ts` | Load persisted announcement and send idempotent email under claim ownership |

## CONVENTIONS

- Use Bun scripts from `package.json`; tests live under `__tests__/` and use Vitest.
- Application behavior depends on injected ports/Effect services; keep external API and D1 details in adapters.
- Discord IDs are snowflakes: compare as `BigInt`, never as JS numbers.
- Validate untrusted Discord and persisted payloads with Effect `Schema` before use.
- Keep errors and logs sanitized; operational docs define what must not be logged.
- D1 changes are additive ordered SQL migrations in `migrations/`.

## ANTI-PATTERNS (THIS PROJECT)

- Do not email messages based only on a webhook ID or crosspost flag; verify message reference, webhook type/source, destination, and optional source allowlists.
- Do not bypass durable D1 discovery/delivery state, claim-token ownership, or stable Resend idempotency keys when changing retry behavior.
- Do not put credentials, recipient/message contents, or raw Discord errors/resource IDs in logs or commits.
- Do not point local, preview, or E2E stages at production resources or credentials.
- Do not grant the Discord bot Administrator; scope permissions to the configured channels.

## COMMANDS

```text
bun run dev          # local Worker
bun run typecheck
bun run test
bun run build        # credential-free bundle to dist/worker.js
bun run check        # Ultracite checks
bun run knip
bun run e2e          # live external side effects; preview credentials/resources only
```

## NOTES

- Only `prod` gets the one-minute scheduled poll; check `docs/deployment.md` before stage changes.
- Read `docs/adr/0001-polling-and-durable-delivery.md` before changing polling, classification, persistence, or delivery guarantees.
- `/admin/*` requires a per-environment `ADMIN_TOKEN`; `/healthz` is intentionally unauthenticated.
