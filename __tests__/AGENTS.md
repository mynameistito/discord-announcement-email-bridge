# **tests** KNOWLEDGE BASE

## OVERVIEW

Vitest coverage for domain rules, application flows, Worker routing, and infrastructure adapters; test files are colocated in this directory rather than beside `src` modules.

## STRUCTURE

```text
*.test.ts       Unit/integration suites grouped by behavior
*-fixtures.ts   Reusable application and D1 fixtures
*-support.ts    Shared test support
fixtures/       Static E2E assets
e2e/            Live external workflow helpers and their isolated tests
```

## WHERE TO LOOK

| Concern | Files | Notes |
| --- | --- | --- |
| Domain classification/schema | `domain.test.ts` | Crosspost acceptance and ordering rules |
| Use cases and HTTP worker | `application.test.ts`, `admin.test.ts`, `worker.test.ts` | Exercise orchestration and route behavior |
| D1 and delivery lifecycle | `d1.test.ts`, `delivery-claim.test.ts`, `polling-history.test.ts` | Repository persistence, leases, cursor recovery |
| Provider and rendering behavior | `resend-adapter.test.ts`, `email-*.test.ts`, `discord-diagnostics.test.ts` | Adapter and output contracts |
| Shared fixtures | `application-fixtures.ts`, `d1-fixture.ts`, `d1-test-support.ts` | Reuse established test setup |

## CONVENTIONS

- Put tests under `__tests__/`; follow the `*.test.ts` naming pattern and Vitest config aliases (`@`, `@scripts`, `@tests`).
- Keep test fixtures representative of actual Discord/D1 data and use stable helpers rather than duplicating setup.
- Prefer testing persisted state transitions and externally observable behavior over implementation-only details.
- E2E tests have real network/resource side effects; consult `e2e/AGENTS.md` and `docs/operations.md` before running them.

## ANTI-PATTERNS

- Do not skip or mock away behavior merely to make a regression test pass.
- Do not use production credentials/resources or send live messages/email from ordinary unit tests.
- Do not put new tests outside `__tests__/`.
