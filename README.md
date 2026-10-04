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
- `GET /admin/status` requires `Authorization: Bearer <ADMIN_TOKEN>` and reports cursor activity and delivery counts.
- `POST /admin/poll` runs discovery immediately.
- `POST /admin/replay` resets terminal failed deliveries to pending and queues them again. Review the failure cause before replaying; Resend idempotency keys are retained for 24 hours, while D1 remains the long-term deduplication source.

Logs contain event names, delivery IDs, and sanitized error messages; do not add email addresses, message contents, or tokens to logs. An edited Discord message does not trigger a new email. A deleted message cannot recall mail already sent.

### Local end-to-end test

Run the full test only against a dedicated non-production Alchemy stage, Discord test bot and followed test channel, Resend test key/sender, and test recipient. Never use the `prod` stage or production credentials. The test sends an email to the configured test recipient. Alchemy stages isolate the Worker, D1 database, and Queues; non-production stages have no Cron Trigger.

Reuse the shared `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` fields already used by the deployment workflow. Do not replace them with E2E-specific values. Add only the dedicated test application fields below to the `discord-announcement-email-bridge` item in the `github-actions` 1Password vault; do not copy production Discord, recipient, or Resend credentials:

- `DISCORD_E2E_BOT_TOKEN`, `DISCORD_E2E_GUILD_ID`, `DISCORD_E2E_TARGET_CHANNEL_ID`
- `EMAIL_E2E_TO`, `RESEND_E2E_API_KEY`, `EMAIL_E2E_FROM_NAME`, `EMAIL_E2E_FROM_EMAIL`
- `ADMIN_E2E_TOKEN`
- `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` if Cloudflare Access protects the test Worker hostname

Install and sign in to the 1Password CLI (`op`), then load these fields into the current PowerShell session. The commands do not print secret values:

```powershell
$item = "op://github-actions/jzwlhhnq7fhnsoazz2esnl4xt4"
$env:CLOUDFLARE_API_TOKEN = op read "$item/CLOUDFLARE_API_TOKEN"
$env:CLOUDFLARE_ACCOUNT_ID = op read "$item/CLOUDFLARE_ACCOUNT_ID"
$env:DISCORD_BOT_TOKEN = op read "$item/DISCORD_E2E_BOT_TOKEN"
$env:DISCORD_GUILD_ID = op read "$item/DISCORD_E2E_GUILD_ID"
$env:DISCORD_TARGET_CHANNEL_ID = op read "$item/DISCORD_E2E_TARGET_CHANNEL_ID"
$env:EMAIL_TO = op read "$item/EMAIL_E2E_TO"
$env:RESEND_API_KEY = op read "$item/RESEND_E2E_API_KEY"
$env:EMAIL_FROM_NAME = op read "$item/EMAIL_E2E_FROM_NAME"
$env:EMAIL_FROM_EMAIL = op read "$item/EMAIL_E2E_FROM_EMAIL"
$env:ADMIN_TOKEN = op read "$item/ADMIN_E2E_TOKEN"
# If the test Worker is behind Cloudflare Access, also load:
# $env:CF_ACCESS_CLIENT_ID = op read "$item/CF_ACCESS_CLIENT_ID"
# $env:CF_ACCESS_CLIENT_SECRET = op read "$item/CF_ACCESS_CLIENT_SECRET"
$env:ALCHEMY_STAGE = "e2e-myname"
$env:STAGE = $env:ALCHEMY_STAGE
```

1. Confirm the test bot can read the test destination channel and its follower webhook metadata, and that a test source Announcement Channel is followed into it. The bot needs the permissions described above, limited to the test channel.
2. Deploy the isolated stage and note the URL printed by Alchemy:

   ```powershell
   bunx alchemy plan --stage $env:ALCHEMY_STAGE
   bunx alchemy deploy --stage $env:ALCHEMY_STAGE
   ```

3. Set the URL printed by Alchemy and build headers for admin calls. If Access protects the Worker, the same headers also include its service token:

   ```powershell
   $url = Read-Host "Non-production Worker URL"
   $headers = @{ Authorization = "Bearer $env:ADMIN_TOKEN" }
   if ($env:CF_ACCESS_CLIENT_ID -and $env:CF_ACCESS_CLIENT_SECRET) {
     $headers["CF-Access-Client-Id"] = $env:CF_ACCESS_CLIENT_ID
     $headers["CF-Access-Client-Secret"] = $env:CF_ACCESS_CLIENT_SECRET
   }
   Invoke-RestMethod -Method Get -Uri "$url/healthz" -Headers $headers
   Invoke-RestMethod -Method Get -Uri "$url/admin/status" -Headers $headers
   ```

   `/admin/status` reports delivery totals and a global `lastPoll` timestamp; it does not show subscription or cursor state. On a fresh E2E stage with no saved cursor, the first poll creates the subscription, seeds at the latest observed message, and skips history. Only run it after confirming the test channel has no unseen announcements you intend to deliver:

   ```powershell
   Invoke-RestMethod -Method Post -Uri "$url/admin/poll" -Headers $headers
   ```

4. Publish one test announcement in the followed source channel and confirm its crosspost appears in the test destination channel. Then invoke `Invoke-RestMethod -Method Post -Uri "$url/admin/poll" -Headers $headers`. **A poll processes all unseen eligible crossposts for enabled subscriptions, not just the announcement you intend to test.** Keep the test destination and recipient isolated accordingly.
5. Check the test mailbox, Resend delivery logs, and `/admin/status`. Queue delivery is asynchronous; allow pending deliveries to finish. A normal destination-channel message is not a valid test. Do not use `/admin/replay` as a smoke test; it can resend previously failed deliveries.

When finished, destroy only this test stage and clear the loaded values from the shell:

```powershell
bunx alchemy destroy --stage $env:ALCHEMY_STAGE
if ($LASTEXITCODE -ne 0) {
  throw "Alchemy destroy failed; credentials remain available so you can retry."
}
"CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "DISCORD_BOT_TOKEN", "DISCORD_GUILD_ID", "DISCORD_TARGET_CHANNEL_ID", "EMAIL_TO", "RESEND_API_KEY", "EMAIL_FROM_NAME", "EMAIL_FROM_EMAIL", "ADMIN_TOKEN", "CF_ACCESS_CLIENT_ID", "CF_ACCESS_CLIENT_SECRET", "ALCHEMY_STAGE", "STAGE" | ForEach-Object {
  Remove-Item "Env:$_" -ErrorAction SilentlyContinue
}
Remove-Variable headers -ErrorAction SilentlyContinue
```

PR CI has no credentials and does not run the poll or send email. It tests the secret-free `/healthz` handler and builds the Worker artifact. The pinned `mynameistito/alchemy-deploy` action does not expose its resolved preview URL as an output; its configured URL pattern is only used internally for deployment reporting. Therefore CI does not claim to smoke-test the deployed PR runtime. Adding that safely requires a stable URL output or another trusted way to resolve the URL from the deployment action.

See [ADR 0001](docs/adr/0001-polling-and-durable-delivery.md) for the polling, classification, and delivery design.
