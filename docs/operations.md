# Operations

## Health and admin endpoints

`GET /healthz` is unauthenticated and returns only basic liveness, stage, and build-version information.

All `/admin/*` routes require:

```http
Authorization: Bearer <ADMIN_TOKEN>
```

| Method and path | Purpose |
| --- | --- |
| `GET /admin/status` | Reports the last poll and pending, failed, and sent delivery counts. |
| `GET /admin/status?discordMessageId=<id>` | Adds sent and failed counts for one follower-copy message. |
| `POST /admin/poll` | Runs discovery immediately. |
| `POST /admin/replay` | Resets terminal failed deliveries to `pending`, queues them again, and runs discovery. |

Review the failure cause before replaying. Resend idempotency keys are retained for 24 hours; D1 remains the long-term deduplication source.

## Polling failures

The cron diagnostic identifies the Discord REST endpoint without logging channel or webhook IDs. A 403 remains a polling failure and does not advance the cursor. A webhook lookup returning 404 is different: the message is treated as missing follower metadata, skipped, and the cursor may advance.

| Endpoint | What to check |
| --- | --- |
| `GET /channels/{channel_id}/messages` | The bot is installed in the destination guild and has `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY`, including channel-specific overwrites. Confirm the configured IDs point to the channel receiving followed posts. |
| `GET /webhooks/{webhook_id}` | The bot has `MANAGE_WEBHOOKS` in the watched destination channel. Strict verification does not trust `webhook_id` alone. |

Common Discord diagnostics:

- `50001` means `Missing Access`; check that the bot can access the target resource.
- `50013` means `Missing Permissions`; check the permissions for the endpoint reported above.
- An HTTP 403 alone does not identify the missing permission or configuration.

The diagnostic contains only the known numeric Discord error code and an allowlisted standard message. Do not share bot tokens, response bodies, message contents, or resource IDs in logs or support requests.

## Delivery and logging

Cloudflare Queues provide at-least-once delivery. D1 records the durable delivery state, while Resend idempotency keys provide a second duplicate guard. Logs contain event names, delivery IDs, and sanitized error messages. Never add email addresses, Discord message contents, tokens, or other secrets to logs.

## Automated live E2E test

The live E2E test publishes a uniquely marked post to a dedicated Discord Announcement Channel, crossposts it, verifies that the receiver already follows the source, waits for the follower copy, polls the bridge, and waits for `/admin/status` to record a successful Resend delivery. It leaves the Discord messages in place as an audit trail and sends a real email to the configured test recipient.

Never use production channels, recipients, or Resend credentials.

### Required Discord permissions

The source and receiver channels must belong to `DISCORD_GUILD_ID`. The preview bot needs:

- Source Announcement Channel: `VIEW_CHANNEL`, `SEND_MESSAGES`, and `MANAGE_MESSAGES`
- Receiver channel: `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY`, and `MANAGE_WEBHOOKS`

### Local run

The test reads its ignored `.env.e2e` from the checked-in field-reference template and 1Password:

```powershell
op inject -i .env.e2e.tpl -o .env.e2e
bun --env-file=.env.e2e run e2e
```

This starts `alchemy dev` in the `e2e-local` stage, runs against the local Worker, stops the development process, and returns to the shell. To select a local Alchemy profile, pass `--profile <name>`; for example:

```powershell
bun --env-file=.env.e2e run e2e --profile preview
```

The local run does not deploy or destroy a remote stage. It needs a preview bot token, guild and channel IDs, preview Resend key, admin token, email sender, and recipient. Cloudflare Access credentials are optional locally; when provided, the runner sends them to protected Worker endpoints. The field names are defined in the workflow and template; keep their values in 1Password.

### GitHub Actions run

On the default branch, manually run **Actions → Discord E2E → Run workflow**. The workflow creates and destroys an isolated stage. Regular CI and pull requests never receive E2E credentials or publish messages.
