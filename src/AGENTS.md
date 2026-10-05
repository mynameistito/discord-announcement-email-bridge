# src KNOWLEDGE BASE

## OVERVIEW

Worker runtime, domain validation, application use cases, and Cloudflare/vendor adapters. Keep the dependency direction flowing from adapters/composition into application/domain contracts.

## STRUCTURE

```text
worker.ts                 Cloudflare event handlers
composition.ts            Concrete environment-to-port wiring
domain.ts                 Schemas, domain types, classification, rendering exports
application/              Polling, delivery, and admin use cases
adapters/                 Discord, D1, Queue, and Resend integrations
resources.ts              Alchemy queue resources
stage-config.ts           Stage names, worker identity, cron policy
email-*.ts                Markdown conversion and HTML/text rendering
```

## WHERE TO LOOK

| Change | Location | Notes |
| --- | --- | --- |
| Worker lifecycle/HTTP routing | `worker.ts`, `composition.ts` | Keep handler concerns thin; bind resource implementations in composition |
| Message acceptance | `domain.ts` | Preserve strict follower-webhook and subscription matching |
| Polling or retry behavior | `application/` | Coordinate with `adapters/d1.ts` and migration state |
| Resource/stage behavior | `resources.ts`, `stage-config.ts` | Production-only cron policy is stage-sensitive |
| Email presentation | `email-markdown*.ts`, `email-renderer.ts` | Rendering receives validated domain data |

## CONVENTIONS

- Use Effect schemas for inbound Discord payloads and JSON restored from D1.
- Keep source IDs as decimal strings; use `compareSnowflakes` for ordering.
- Application services declare ports and typed failures; environment access belongs at the composition/adapter edge.
- Keep HTTP errors and logs sanitized; admin routes are authorized in `worker.ts` before dispatch.

## ANTI-PATTERNS

- Do not loosen crosspost verification to trust a single Discord field.
- Do not mark a delivery complete unless the claim token still owns it.
- Do not bypass queue/D1 delivery workflow for convenience or put provider-specific behavior into domain classification.
