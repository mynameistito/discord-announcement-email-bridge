# Development

## Requirements

- Bun 1.4.2
- A local copy of the repository
- Non-production credentials if you run the Worker against Discord, Cloudflare, or Resend

## Install and run locally

```powershell
Copy-Item .env.example .env
bun install --frozen-lockfile
bun run dev
```

Fill in `.env` before running `bun run dev`. Alchemy's local workflow may provision local resources. Do not point local work at production D1, Queues, Discord credentials, or email credentials.

## Local validation

Run the smallest relevant check while iterating, then run the full set before opening a pull request:

```powershell
bun run typecheck
bun run test
bun run build
bun run check
```

`bun run build` creates the browser-targeted Worker bundle at `dist/worker.js`. The bundle is ignored, does not deploy, and does not require Cloudflare credentials.

CI runs the same checks plus Knip. Pull requests also produce a credential-free Worker bundle for the preview deployment workflow.

## Manual stage work

Use a dedicated stage when you need to deploy locally. Set `ALCHEMY_STAGE` to the same value passed to `--stage`:

```powershell
$env:ALCHEMY_STAGE = "dev-myname"
$env:STAGE = $env:ALCHEMY_STAGE
bunx alchemy plan --stage $env:ALCHEMY_STAGE
bunx alchemy deploy --stage $env:ALCHEMY_STAGE
```

Only the `prod` stage receives the one-minute Cron Trigger. Local, PR, and other development stages have no automatic polling. See [Deployment](deployment.md) for the stage naming rules and credential requirements.

## Design reference

Read [ADR 0001](adr/0001-polling-and-durable-delivery.md) before changing polling, classification, persistence, or delivery behavior.
