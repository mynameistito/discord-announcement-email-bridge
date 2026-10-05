# Discord announcement email bridge

A Cloudflare Worker polls a Discord Announcement Channel once a minute, verifies Channel Follower crossposts, stores discoveries in D1, and sends one email per configured recipient through Resend. Cloudflare Queues provide at-least-once delivery; D1 and Resend idempotency keys protect retries.

## Requirements

- Bun 1.4.2
- A Cloudflare account with Workers, D1, and Queues enabled
- A Discord bot installed in the destination guild with `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY`, `MANAGE_WEBHOOKS`, and the privileged `MESSAGE_CONTENT` intent enabled in the Developer Portal
- A Resend account and a verified sender domain

The bot must be able to read the destination channel and look up its Channel Follower webhook metadata. This app uses strict webhook verification, so `MANAGE_WEBHOOKS` is required; it will not send mail based on `webhook_id` alone. Grant the permission only where the bot needs it, and do not grant Administrator.

## Invite the bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), open the bot application. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. The Worker polls Discord's REST API; it does not need a Gateway connection.
2. Open **OAuth2 → URL Generator**. Select the `bot` scope. Under **Bot Permissions**, select **View Channels**, **Read Message History**, and **Manage Webhooks**. Do not select `Administrator` or `applications.commands`. The equivalent guild-install URL uses permission value `536937472`:

   ```powershell
   $clientId = "<APPLICATION_CLIENT_ID>" # Developer Portal → General Information → Application ID
   $inviteUrl = "https://discord.com/oauth2/authorize?client_id=$clientId&permissions=536937472&integration_type=0&scope=bot"
   Start-Process $inviteUrl
   ```

   Replace the placeholder with the Application ID, then choose and authorize the destination server.

3. In that server, make sure the bot can view the channel that will receive followed announcements. Apply `View Channel`, `Read Message History`, and `Manage Webhooks` there. `Manage Webhooks` is a powerful permission; limit it to the destination channel if your server setup allows it.
4. Put the bot's token in the deployment secret `DISCORD_BOT_TOKEN` (for GitHub deployments, the `discord-announcement-email-bridge` item in the `github-actions` 1Password vault). Never put the token in source control or share it in chat. Redeploy after changing the token or either configured Discord ID; the Worker does not read 1Password at runtime.
5. Enable Discord **Developer Mode** and copy the destination server and channel IDs into `DISCORD_GUILD_ID` and `DISCORD_TARGET_CHANNEL_ID`. These IDs must describe the guild and channel where the followed copies arrive.
6. In the source server's Announcement Channel, use **Follow** and select the destination server and channel configured above. The bot only processes verified Channel Follower crossposts that appear in this destination channel; an ordinary message posted there is ignored.

## Troubleshoot Discord polling failures

Cron failures identify the Discord REST endpoint without logging channel or webhook IDs. A 403 remains a polling failure and does not advance the cursor. A webhook lookup returning 404 is different: the message is treated as missing follower metadata, skipped, and the cursor may advance.

- `GET /channels/{channel_id}/messages` reads the configured destination channel. Check that the bot is installed in the destination guild and has `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY` for that channel, including channel-specific permission overwrites. Confirm the configured destination guild and channel IDs refer to the channel receiving the followed posts.
- `GET /webhooks/{webhook_id}` verifies Channel Follower metadata. This strict verification call requires `MANAGE_WEBHOOKS` in the watched destination channel; the service intentionally does not fall back to trusting a message's `webhook_id` alone.
- Discord error `50001` means `Missing Access` and commonly indicates the bot cannot access the target resource. Error `50013` means `Missing Permissions`; check the permissions required by the reported endpoint above. An HTTP 403 by itself does not establish which permission or configuration is wrong.

The diagnostic contains only the known numeric Discord error code and an allowlisted standard message. Do not include bot tokens, response bodies, message contents, or resource IDs when sharing logs.

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

GitHub Actions deploys only after successful CI: `main` deploys the `prod` Alchemy stage to `https://discord-announcement-email-bridge-prod.mynameistito.workers.dev`, and same-repository pull requests get isolated `pr-<number>` Workers at `https://discord-announcement-email-bridge-pr-<number>.mynameistito.workers.dev`. CI builds and uploads the Worker bundle without secrets. A trusted `workflow_run` job checks out deployment code from the default branch (pinned to the exact CI commit for production) and uploads only that prebuilt bundle; PR-controlled deployment scripts never run with the Cloudflare token. This workflow must already exist on the default branch, so a PR that first introduces it cannot use it to deploy its own preview. Preview Cron Triggers are disabled. Closing a same-repository PR destroys only that preview stage. Fork PRs never receive deployment credentials. The deploy workflow loads values from the `discord-announcement-email-bridge` item in the `github-actions` 1Password vault.

Before enabling deployment, configure these fields in that 1Password item:

| Fields | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Shared Cloudflare account token and account ID for production and stage-isolated PR resources. |
| `DISCORD_PREVIEW_BOT_TOKEN`, `DISCORD_PREVIEW_TARGET_CHANNEL_ID` | Dedicated preview bot and test announcement channel; previews use the production `DISCORD_GUILD_ID`. |
| `RESEND_PREVIEW_API_KEY` | Dedicated Resend API key loaded only by PR preview deployments. |
| `ADMIN_PREVIEW_TOKEN` | Separate random bearer token for preview admin routes. |

Production and PR deployments use the same Cloudflare account and API token, but the token is available only to the trusted deployment workflow; PR CI receives no deployment secrets. Alchemy isolates Workers, D1 databases, and Queues by stage. Previews use the preview Discord bot and test channel, the production guild ID, and `RESEND_PREVIEW_API_KEY`. They still use the configured `EMAIL_TO` and sender fields, so use a test recipient and a preview-restricted sender/key if PR code is not fully trusted. Preview Cron Triggers are disabled, but PR-controlled code can still access its bound preview credentials and invoke admin routes.

Also add the repository Actions secret `OP_SERVICE_ACCOUNT_TOKEN`, containing the 1Password service-account token. Scope that service account to read only the `github-actions` vault. The workflow receives this bootstrap token from GitHub; all application and Cloudflare credentials are then resolved from the 1Password item. `GITHUB_TOKEN` is provided by GitHub and needs no separate secret.

The Cloudflare API token needs account-scoped write access for Workers Scripts, D1, and Queues; include Account Settings Read if the token UI/provider requires account metadata lookup. Do not grant Workers Routes access unless a custom route/domain is added. Cloudflare's current permission names may appear as `Write` or legacy `Edit`; see [API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) and the [Workers permissions guide](https://developers.cloudflare.com/workers/authorization/workers/).

For a manual local deployment, use a dedicated Alchemy stage and profile. Set `ALCHEMY_STAGE` to the same value passed to `--stage`; this controls the explicit Worker name and disables preview crons:

```powershell
$env:ALCHEMY_STAGE = "dev-myname"
$env:STAGE = $env:ALCHEMY_STAGE
bunx alchemy plan --stage $env:ALCHEMY_STAGE
bunx alchemy deploy --stage $env:ALCHEMY_STAGE
```

Never use a production profile or stage for preview builds. Only the `prod` stage receives the one-minute Cron; local and PR stages have no automatic polling. D1 migrations are applied by Alchemy. The dead-letter queue name is bound directly from the stage-specific Alchemy queue resource, so previews do not need a manually copied production queue name.

- `GET /healthz` reports basic liveness and the stage/version.
- `GET /admin/status` requires `Authorization: Bearer <ADMIN_TOKEN>` and reports cursor activity and delivery counts. Supplying `?discordMessageId=<id>` also reports counts for the follower copy's delivery.
- `POST /admin/poll` runs discovery immediately.
- `POST /admin/replay` resets terminal failed deliveries to pending and queues them again. Review the failure cause before replaying; Resend idempotency keys are retained for 24 hours, while D1 remains the long-term deduplication source.

Logs contain event names, delivery IDs, and sanitized error messages; do not add email addresses, message contents, or tokens to logs. An edited Discord message does not trigger a new email. A deleted message cannot recall mail already sent.

### Automated live end-to-end test

The live E2E publishes a uniquely marked post to a dedicated Discord Announcement Channel, crossposts it, verifies that the receiver already follows that source, confirms the follower copy arrives, polls the bridge, and waits for `/admin/status` to record a successful Resend delivery. It leaves the Discord messages in place as an audit trail and sends a real email to the configured test recipient. Never use production channels, recipient, or Resend credentials.

The source and receiver channels must belong to `DISCORD_GUILD_ID`. The preview bot must be installed in that guild, have `VIEW_CHANNEL`, `SEND_MESSAGES`, and `MANAGE_MESSAGES` in the source Announcement Channel, and have `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY`, and `MANAGE_WEBHOOKS` in the receiver channel. The test reads the existing `DISCORD_PREVIEW_BOT_TOKEN`, `RESEND_PREVIEW_API_KEY`, `ADMIN_PREVIEW_TOKEN`, `DISCORD_GUILD_ID`, `EMAIL_TO`, `EMAIL_FROM_NAME`, and `EMAIL_FROM_EMAIL` fields, plus `DISCORD_E2E_ANNOUNCEMENT_CHANNEL_ID` and `DISCORD_E2E_RECEIVER_CHANNEL_ID`, from the `add more` section of the `discord-announcement-email-bridge` item in the `github-actions` 1Password vault. It also loads `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` from that section for protected Worker URLs. Set `EMAIL_TO` to the test mailbox. Add `CLOUDFLARE_PREVIEW_API_TOKEN` and `CLOUDFLARE_PREVIEW_ACCOUNT_ID` as new fields on this vault item; use a preview-scoped token and the preview account ID, not the shared production deployment credentials. `OP_SERVICE_ACCOUNT_TOKEN` is a repository secret.

For a local run, install and sign in to the 1Password CLI, then materialize the ignored `.env.e2e` from the checked-in field-reference template and run the test:

```powershell
op inject -i .env.e2e.tpl -o .env.e2e
bun --env-file=.env.e2e run e2e
```

This starts `alchemy dev` in the `e2e-local` stage, runs the live test against its local Worker, stops the dev process, and returns to the shell. To select the local Alchemy profile, pass `--profile <name>` (for example, `bun --env-file=.env.e2e run e2e --profile preview`). It does not deploy or destroy a remote stage.

For GitHub Actions, manually run **Actions → Discord E2E → Run workflow**. It creates a unique non-production Alchemy stage, runs the same test against it, and destroys only that stage afterward. The E2E Worker URL currently uses the `mynameistito.workers.dev` account subdomain; update `.github/workflows/e2e.yml` if the Workers account or configured subdomain changes. Regular CI and pull requests never receive E2E credentials or publish messages.

See [ADR 0001](docs/adr/0001-polling-and-durable-delivery.md) for the polling, classification, and delivery design.
