# Deployment

The project uses Alchemy to provision a Worker, D1 database, delivery Queues, and the Queue consumers. GitHub Actions separates credential-free CI from trusted deployment work.

## GitHub Actions deployments

- A push to `main` deploys the `prod` stage to `https://discord-announcement-email-bridge-prod.mynameistito.workers.dev`.
- A same-repository pull request gets an isolated `pr-<number>` Worker.
- Preview Cron Triggers are disabled. Closing a same-repository pull request destroys only its preview stage.
- Fork pull requests never receive deployment credentials.
- CI builds the Worker bundle without secrets. A trusted `workflow_run` job deploys that prebuilt bundle; pull-request deployment scripts do not run with the Cloudflare token.
- A pull request that first introduces or changes the deployment workflow cannot use that new workflow to deploy its own preview until the workflow exists on the default branch.

## Required credentials

The deployment workflow reads the `discord-announcement-email-bridge` item in the `github-actions` 1Password vault. Production deploys use the application fields below. PR previews load only the Cloudflare fields and run without Discord, Resend, or admin credentials, so they are infrastructure previews and cannot poll or send email.

Configure these fields before enabling deployment:

| Fields | Used for |
| --- | --- |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Production and stage-isolated Worker, D1, and Queue resources. |
| `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_TARGET_CHANNEL_ID` | Production Discord polling. |
| `EMAIL_TO`, `RESEND_API_KEY`, `EMAIL_FROM_NAME`, `EMAIL_FROM_EMAIL` | Production email delivery. |
| `ADMIN_TOKEN` | Production admin routes. |

Also add the repository Actions secret `OP_SERVICE_ACCOUNT_TOKEN`. Scope that 1Password service account to read only the `github-actions` vault. `GITHUB_TOKEN` is provided by GitHub.

Production and PR deployments share the Cloudflare account and API token, but only the trusted deployment workflow receives the deployment credentials. Alchemy isolates each stage's Worker, D1 database, and Queues. Use a test recipient and preview-restricted sender/key for preview work.

The Cloudflare API token needs account-scoped write access for Workers Scripts, D1, and Queues. Include Account Settings Read if the token provider requires account metadata lookup. Workers Routes access is not needed unless a custom route or domain is added. See [Cloudflare API token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) and the [Workers permissions guide](https://developers.cloudflare.com/workers/authorization/workers/).

The manually triggered E2E workflow uses separate non-production fields: `CLOUDFLARE_PREVIEW_API_TOKEN`, `CLOUDFLARE_PREVIEW_ACCOUNT_ID`, `DISCORD_PREVIEW_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_E2E_ANNOUNCEMENT_CHANNEL_ID`, `DISCORD_E2E_RECEIVER_CHANNEL_ID`, `EMAIL_TO`, `RESEND_PREVIEW_API_KEY`, `EMAIL_FROM_NAME`, `EMAIL_FROM_EMAIL`, `ADMIN_PREVIEW_TOKEN`, `CF_ACCESS_CLIENT_ID`, and `CF_ACCESS_CLIENT_SECRET`. These fields are for the [live E2E test](operations.md#automated-live-e2e-test), not ordinary PR previews.

## Manual deployment

Use a dedicated Alchemy profile and stage for local deployment:

```powershell
$env:ALCHEMY_STAGE = "dev-myname"
$env:STAGE = $env:ALCHEMY_STAGE
bunx alchemy plan --stage $env:ALCHEMY_STAGE
bunx alchemy deploy --stage $env:ALCHEMY_STAGE
```

The stage label must use lowercase letters, numbers, and single hyphens. The resulting Worker name must be no longer than 63 characters. Alchemy applies the D1 migrations and binds the stage-specific dead-letter Queue automatically.

Never use a production profile or stage for preview builds. Only `prod` gets the `* * * * *` Cron Trigger; all other stages require an explicit `POST /admin/poll` when you want to run discovery.

## E2E deployment

The manually triggered **Discord E2E** workflow creates a unique non-production stage, runs the full Discord → Worker → Resend flow, and destroys that stage afterward. The live test requires dedicated Discord channels, a preview bot, preview Resend credentials, Cloudflare Access service credentials, and a preview-scoped Cloudflare token. See [Operations](operations.md#automated-live-e2e-test) for the required permissions and test steps.
