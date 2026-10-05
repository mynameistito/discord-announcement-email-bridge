# Discord announcement email bridge

A Cloudflare Worker that turns verified Discord Announcement Channel crossposts into email notifications.

```text
Discord announcement
        │ Channel Following
        ▼
Destination channel → Worker poll → D1 → Cloudflare Queue → Resend → Email
```

The Worker polls once a minute in production. It only sends mail for crossposts that pass Discord's follower-webhook checks; ordinary messages in the destination channel are ignored. D1 and Resend idempotency keys protect retries from sending duplicates.

## Start here

1. [Set up the Discord bot and follower channel](docs/configuration.md#discord-setup)
2. [Configure environment variables](docs/configuration.md#environment-variables)
3. [Run the local checks](docs/development.md#local-validation)
4. [Deploy to a dedicated stage or through GitHub Actions](docs/deployment.md)

### Requirements

- [Bun 1.4.2](https://bun.sh/)
- A Cloudflare account with Workers, D1, and Queues
- A Discord bot with the permissions and privileged intent described in the [configuration guide](docs/configuration.md)
- A Resend account with a verified sender domain

## Quick local setup

```powershell
Copy-Item .env.example .env
bun install --frozen-lockfile
bun run dev
```

Fill in `.env` before starting the Worker. Local development may provision local Alchemy resources; use a dedicated stage and non-production credentials when deploying remotely.

To validate changes without deploying:

```powershell
bun run typecheck
bun run test
bun run build
bun run check
```

## Documentation

The [documentation index](docs/README.md) links to the detailed guides:

- [Configuration](docs/configuration.md) — Discord setup, environment variables, and first-start behavior
- [Development](docs/development.md) — local development and validation
- [Deployment](docs/deployment.md) — production, PR previews, manual stages, and deployment credentials
- [Operations](docs/operations.md) — admin endpoints, troubleshooting, replay, logging, and the live E2E test
- [ADR 0001](docs/adr/0001-polling-and-durable-delivery.md) — why the bridge uses polling, D1, and Queues

## Security basics

- Never commit `.env`, bot tokens, API keys, bearer tokens, or Cloudflare credentials.
- Do not grant the Discord bot `Administrator`; restrict `Manage Webhooks` to the watched destination channel where possible.
- Keep preview and test stages isolated from production D1, Queues, Discord credentials, recipients, and sender credentials.
- Treat `/admin/*` as protected operational endpoints and use a separate `ADMIN_TOKEN` for each environment.

## Contributing

Run the validation commands above before opening a pull request. CI also runs Knip, type checking, tests, and a credential-free Worker build.
