# Configuration

This guide covers the Discord and runtime configuration needed by one bridge subscription.

## Discord setup

The bot must be installed in the destination guild and able to read the channel that receives followed announcements.

1. In the [Discord Developer Portal](https://discord.com/developers/applications), open the bot application. Under **Bot → Privileged Gateway Intents**, enable **Message Content Intent**. The Worker uses Discord's REST API and does not need a Gateway connection.
2. Open **OAuth2 → URL Generator**. Select the `bot` scope and these bot permissions:
   - `View Channels`
   - `Read Message History`
   - `Manage Webhooks`

   Do not select `Administrator` or `applications.commands`. The equivalent guild-install URL uses permission value `536937472`:

   ```powershell
   $clientId = "<APPLICATION_CLIENT_ID>"
   $inviteUrl = "https://discord.com/oauth2/authorize?client_id=$clientId&permissions=536937472&integration_type=0&scope=bot"
   Start-Process $inviteUrl
   ```

3. Install the bot in the destination server. Apply the same permissions to the destination channel, including any channel-specific permission overwrites. `Manage Webhooks` is required for strict follower verification, so limit it to that channel if the server setup allows it.
4. Store the bot token as the deployment secret `DISCORD_BOT_TOKEN`. Never put it in source control or chat. Redeploy after changing the token or either configured Discord ID.
5. Enable Discord **Developer Mode** and copy the destination server and channel IDs into `DISCORD_GUILD_ID` and `DISCORD_TARGET_CHANNEL_ID`.
6. In the source server's Announcement Channel, use **Follow** and select the destination server and channel. The bridge ignores ordinary messages posted directly to the destination channel.

The bot must be able to read message content, embeds, and attachments. If Discord withholds those fields because the privileged intent is not enabled, the bridge logs an `announcement.content_unavailable` warning and skips that announcement while advancing the cursor; it will not be retried. Enable the intent before polling.

## Environment variables

Copy `.env.example` to `.env` for local work. For deployed stages, configure protected environment values or deployment secrets instead.

| Variable | Required | Description |
| --- | --- | --- |
| `DISCORD_BOT_TOKEN` | Yes | Discord bot token. Keep it secret. |
| `DISCORD_GUILD_ID` | Yes | Destination guild containing the followed channel. |
| `DISCORD_TARGET_CHANNEL_ID` | Yes | Destination channel where followed announcements arrive. |
| `EMAIL_TO` | Yes | Recipient address for this subscription. |
| `RESEND_API_KEY` | Yes | Resend API key. Keep it secret. |
| `EMAIL_FROM_NAME` | Yes | Display name shown in the email, such as `Announcements`. |
| `EMAIL_FROM_EMAIL` | Yes | Verified Resend sender address. |
| `ADMIN_TOKEN` | Yes for admin routes | Random bearer token for `/admin/*`. |
| `SOURCE_GUILD_ID` | No | Restrict matching to one source guild. |
| `SOURCE_CHANNEL_ID` | No | Restrict matching to one source channel. |
| `STAGE` | No | Stage label returned by `/healthz`; set it to the deployment stage. |

The source filters are optional. When set, they provide an additional check against the source metadata on the follower webhook.

## Startup behavior

The Worker creates a subscription for the configured destination and recipient. On first startup it sets the cursor to the latest observed message, so historical announcements are not sent. Configure a dedicated non-production stage for testing.

An edited Discord message does not trigger a new email. A deleted message cannot recall mail that was already sent.

## Secret handling

Keep local `.env` files untracked. For GitHub deployments, the deployment workflows load credentials from the `discord-announcement-email-bridge` item in the `github-actions` 1Password vault; the Worker does not read 1Password at runtime. See the [deployment guide](deployment.md) for the required fields and GitHub secret.
