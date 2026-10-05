# src/adapters KNOWLEDGE BASE

## OVERVIEW

Infrastructure boundary for Discord reads, D1 persistence, Cloudflare Queue processing, and Resend email delivery.

## WHERE TO LOOK

| Concern | File | Notes |
| --- | --- | --- |
| Discord REST reads and metadata | `discord.ts` | Converts API results/errors to application/domain inputs |
| D1 repository and schema queries | `d1.ts` | Polling repository, durable cursors and discovery records |
| Delivery claims and state transitions | `d1-deliveries.ts` | Lease/generation-aware claim, failure, and dead-letter updates |
| Queue batch handling | `queue.ts` | Claim-aware processing and retry/dead-letter behavior |
| Resend API | `resend.ts` | Email send adapter; stable idempotency key comes from durable delivery data |
| Stable identifiers | `idempotency-key.ts` | Deterministic delivery key construction |

## CONVENTIONS

- Wrap infrastructure failures in `BridgeInfrastructureError` or the API-specific typed error; preserve retryability.
- Keep SQL parameterized and state transitions conditional on current status/claim ownership.
- `d1.ts` provides polling operations; delivery claim/update queries are intentionally isolated in `d1-deliveries.ts`.
- Do not expose raw provider responses or credentials in logs/errors.

## ANTI-PATTERNS

- Do not treat Queue delivery as exactly-once; it is at-least-once and must be reconciled with D1 and Resend idempotency.
- Do not replace conditional D1 updates with read-then-write state changes that can race.
- Do not swallow transient infrastructure failures or mark them terminal without honoring retryability.
