# src/application KNOWLEDGE BASE

## OVERVIEW

Effect-based use cases coordinate bridge behavior through typed ports and services; external I/O implementations stay outside this directory.

## WHERE TO LOOK

| Concern | Files | Notes |
| --- | --- | --- |
| Poll orchestration | `polling.ts`, `polling-subscription.ts` | `PollingService` supplies Discord/repository/queue ports |
| History and cursor recovery | `polling-history.ts`, `polling-classification.ts` | First-run initialization and ordered discovery classification |
| Persisting/enqueueing discovery | `polling-deliveries.ts` | Pending deliveries are re-enqueued after discovery |
| Email delivery | `delivery.ts`, `delivery-error.ts` | Rebuilds validated announcement and completes only with active claim token |
| Admin operations | `admin.ts` | Auth, health, status, poll, replay, subscription setup |

## CONVENTIONS

- Inject concrete dependencies through Effect service tags/port interfaces; use cases should not import vendor SDK calls.
- Represent infrastructure and Discord failures with typed errors so retryability remains explicit.
- Treat each subscription's polling failure independently, but return an aggregate failure to the caller.
- Keep admin responses and error strings sanitized; see `docs/operations.md` for the public operational contract.

## ANTI-PATTERNS

- Do not advance cursors after failed Discord reads or before discovered announcements are durably persisted.
- Do not make queue enqueueing the source of truth; D1 records pending state so work can be recovered.
- Do not resend or update delivery state without preserving idempotency and claim ownership semantics.
