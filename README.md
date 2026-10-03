# Discord channel updates to email

A Cloudflare Worker polls a Discord Announcement Channel once a minute, verifies Channel Follower crossposts, stores discoveries in D1, and sends one email per configured recipient through Resend. Cloudflare Queues provide at-least-once delivery; D1 and Resend idempotency keys protect retries.

## Requirements

- Bun 1.4.2
- A Cloudflare account with Workers, D1, and Queues enabled
- A Discord bot installed in the destination guild with `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY`, `MANAGE_WEBHOOKS`, and the privileged `MESSAGE_CONTENT` intent enabled in the Developer Portal
- A Resend account and a verified sender domain

The bot needs access to the destination Announcement Channel and each followed source channel's webhook metadata. Do not grant `MANAGE_WEBHOOKS` unless strict Channel Follower verification is required; without it, this application does not send mail because `webhook_id` alone is not sufficient proof.

## Configure

Set these values in a local `.env` for Alchemy (never commit it) or configure them as protected deployment secrets/environment values:

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Yes | Bot token; stored as a secret. |
| `DISCORD_GUILD_ID` | Yes | Destination guild containing the followed channel. |
| `DISCORD_TARGET_CHANNEL_ID` | Yes | Destination Announcement Channel ID. |
| `EMAIL_TO` | Yes | Recipient address for this subscription. |
| `RESEND_API_KEY` | Yes | Resend API key; stored as a secret. |
| `EMAIL_FROM` | Yes | Verified Resend sender, e.g. `Announcements <updates@example.com>`. |
| `ADMIN_TOKEN` | Yes for admin routes | Random bearer token for `/admin/*`. |
| `DELIVERY_DEAD_LETTER_QUEUE_NAME` | Yes for failure accounting | Queue name printed in Alchemy's stack outputs; set it in the Worker environment. |
| `SOURCE_GUILD_ID` | No | Restrict matching to one source guild. |
| `SOURCE_CHANNEL_ID` | No | Restrict matching to one source channel. |
| `STAGE` | No | Stage label returned by `/healthz`; set it to the deployment stage. |

The Worker creates a subscription for the configured destination and recipient. On first startup it initializes the cursor to the latest observed message and does not send historical announcements. Configure a dedicated non-production Cloudflare account/stage for testing; never point previews at production D1, Queues, Discord credentials, or email sending credentials.

For local configuration, copy `.env.example` to `.env` and fill in the values.

## Local validation

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run build
bun run check
```

`bun run build` creates a browser-targeted Worker bundle under ignored `dist/`; it does not deploy or require Cloudflare credentials. `bun run dev` starts Alchemy's local development workflow and may provision local resources.

## Deploy and operate

Use a dedicated Alchemy stage and profile for each environment. Review the plan before deploying:

```sh
bun node_modules/alchemy/bin/alchemy.js plan --stage <stage>
bun node_modules/alchemy/bin/alchemy.js deploy --stage <stage>
```

Never use a production profile or stage for preview builds. The one-minute Cron polls the destination channel; D1 migrations are applied by Alchemy. Configure the same values in the Worker environment, keeping tokens in secret storage. After the first deployment, copy `deadLetterQueueName` from the stack outputs into `DELIVERY_DEAD_LETTER_QUEUE_NAME` and redeploy so exhausted queue retries are recorded as terminal failures and become visible to `/admin/status` and `/admin/replay`.

- `GET /healthz` reports basic liveness and the stage/version.
- `GET /admin/status` requires `Authorization: Bearer <ADMIN_TOKEN>` and reports cursor activity and delivery counts.
- `POST /admin/poll` runs discovery immediately.
- `POST /admin/replay` resets terminal failed deliveries to pending and queues them again. Review the failure cause before replaying; Resend idempotency keys are retained for 24 hours, while D1 remains the long-term deduplication source.

Logs contain event names, delivery IDs, and sanitized error messages; do not add email addresses, message contents, or tokens to logs. An edited Discord message does not trigger a new email. A deleted message cannot recall mail already sent.

See [ADR 0001](docs/adr/0001-polling-and-durable-delivery.md) for the polling, classification, and delivery design.
