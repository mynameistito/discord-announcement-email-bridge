# __tests__/e2e KNOWLEDGE BASE

## OVERVIEW

Helpers for the live Discord → Worker → D1/Queue → Resend workflow; this test creates real Discord announcements and sends real email.

## WHERE TO LOOK

| Concern | File | Notes |
| --- | --- | --- |
| E2E domain/config and types | `config.ts`, `types.ts` | Parse environment/flags and validate required preview configuration |
| Discord setup and posts | `discord.ts` | Verify follower setup, publish and crosspost announcements |
| Local Worker lifecycle | `local-worker.ts` | Starts/stops isolated Alchemy dev stage with cleanup |
| Worker admin/poll assertions | `worker.ts`, `http.ts` | Seed cursor, trigger poll, await sent status |
| Complete workflow | `workflow.ts` | Runs both rich and simple announcement paths |
| Deterministic fixture | `photo-fixture.ts` | Loads committed public-domain image fixture |
| Helper unit tests | `helpers.test.ts` | Covers reusable E2E support behavior without the full live run |

## CONVENTIONS

- Keep network calls abortable and bound by explicit timeouts; honor the provided `AbortSignal`.
- Run local E2E only with preview credentials/resources; `--profile` applies to local mode only.
- The E2E sends live posts that remain as an audit trail. Never use production channels, recipients, or Resend credentials.
- Read `docs/operations.md` for required Discord permissions and supported local/GitHub Actions invocations.

## ANTI-PATTERNS

- Do not run this workflow as part of ordinary unit-test commands or with production configuration.
- Do not log credentials, message contents, raw provider responses, or sensitive resource identifiers.
- Do not omit cleanup of local Alchemy processes when changing workflow lifecycle behavior.
