# Discord announcement email bridge

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
| `EMAIL_FROM_NAME` | Yes | Display name for the sender, e.g. `Announcements`. |
| `EMAIL_FROM_EMAIL` | Yes | Verified Resend sender address, e.g. `updates@example.com`. |
| `ADMIN_TOKEN` | Yes for admin routes | Random bearer token for `/admin/*`. |
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

GitHub Actions deploys only after successful CI: `main` deploys the `prod` Alchemy stage to `https://discord-announcement-email-bridge-prod.mynameistito.workers.dev`, and same-repository pull requests get isolated `pr-<number>` Workers at `https://discord-announcement-email-bridge-pr-<number>.mynameistito.workers.dev`. Preview Cron Triggers are disabled to prevent automatic polling and email delivery. Closing a same-repository PR destroys only that preview stage. Fork PRs never receive deployment credentials. The deploy workflow loads values from the `discord-announcement-email-bridge` item in the `github-actions` 1Password vault.

Before enabling deployment, configure these fields in that 1Password item:

| Fields | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Shared Cloudflare account token and account ID for production and stage-isolated PR resources. |
| `PRODUCTION_URL` | `https://discord-announcement-email-bridge-prod.mynameistito.workers.dev`, used in deployment reports. |
| `DISCORD_PREVIEW_BOT_TOKEN`, `DISCORD_PREVIEW_TARGET_CHANNEL_ID` | Dedicated preview bot and test announcement channel; previews use the production `DISCORD_GUILD_ID`. |
| `ADMIN_PREVIEW_TOKEN` | Separate random bearer token for preview admin routes. |

Production and PR Workers use the same Cloudflare account and API token; Alchemy isolates their Workers, D1 databases, and Queues by stage. Previews use the preview Discord bot and target channel, but the production guild ID and Resend key, recipient, and sender. PR previews are only deployed for same-repository PRs, and their Cron Triggers are disabled. PR-controlled Worker code can read and exfiltrate its bound production Resend key or send real mail; this is not a security boundary. Only trusted contributors should be allowed to create same-repository PRs. Use a test Resend key and recipient instead if PR authors are not fully trusted.

Also add the repository Actions secret `OP_SERVICE_ACCOUNT_TOKEN`, containing the 1Password service-account token. Scope that service account to read only the `github-actions` vault. The workflow receives this bootstrap token from GitHub; all application and Cloudflare credentials are then resolved from the 1Password item. `GITHUB_TOKEN` is provided by GitHub and needs no separate secret.

The Cloudflare API token needs account-scoped write access for Workers Scripts, D1, and Queues; include Account Settings Read if the token UI/provider requires account metadata lookup. Do not grant Workers Routes access unless a custom route/domain is added. Cloudflare's current permission names may appear as `Write` or legacy `Edit`; see [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) and the [Workers permissions guide](https://developers.cloudflare.com/workers/authorization/workers/).

For a manual local deployment, use a dedicated Alchemy stage and profile. Review the plan before deploying:

```sh
bunx alchemy plan --stage <stage>
bunx alchemy deploy --stage <stage>
```

Never use a production profile or stage for preview builds. The one-minute Cron polls the configured destination; D1 migrations are applied by Alchemy. The dead-letter queue name is bound directly from the stage-specific Alchemy queue resource, so previews do not need a manually copied production queue name.

- `GET /healthz` reports basic liveness and the stage/version.
- `GET /admin/status` requires `Authorization: Bearer <ADMIN_TOKEN>` and reports cursor activity and delivery counts.
- `POST /admin/poll` runs discovery immediately.
- `POST /admin/replay` resets terminal failed deliveries to pending and queues them again. Review the failure cause before replaying; Resend idempotency keys are retained for 24 hours, while D1 remains the long-term deduplication source.

Logs contain event names, delivery IDs, and sanitized error messages; do not add email addresses, message contents, or tokens to logs. An edited Discord message does not trigger a new email. A deleted message cannot recall mail already sent.

See [ADR 0001](docs/adr/0001-polling-and-durable-delivery.md) for the polling, classification, and delivery design.
