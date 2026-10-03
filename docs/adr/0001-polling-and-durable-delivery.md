# ADR 0001: Poll Discord with durable asynchronous delivery

- Status: Accepted
- Date: 2026-10-03

## Context

The service must only email actual Discord Announcement Channel copies that have already been propagated through Channel Following. Discord's HTTP Webhook Events do not provide ordinary guild message-create events. The Gateway does, but requires a long-lived WebSocket, heartbeat, reconnect, and resume lifecycle. Cloudflare can open outbound WebSockets, but a stateless Worker invocation is not an appropriate owner for a permanent connection; a Durable Object would add a permanent stateful component for a latency improvement of at most one minute.

Discord's documented follower webhook object has type `2` and contains `source_guild` and `source_channel` metadata. A propagated message is documented with `IS_CROSSPOST` and a `message_reference` pointing at its source message. `webhook_id` alone is insufficient to establish authenticity. The documented webhook lookup endpoint requires `MANAGE_WEBHOOKS`, so strict verification uses this permission in addition to channel read access.

## Decision

Use a once-per-minute Cloudflare Cron Trigger to poll each configured destination channel through Discord REST. Fetch at most 100 messages per request and continue `after` pagination until caught up. Sort by Snowflake ID oldest-first. Persist each observed message and its delivery in D1 before advancing a channel cursor. D1 uniqueness constraints protect overlapping/repeated polls. Enqueue stable delivery identifiers into a Cloudflare Queue; a separate queue handler renders and sends via Resend.

The classifier requires both `IS_CROSSPOST` and a complete source `message_reference`, then verifies the message's webhook ID against a cached/fetched webhook of type `2` whose source IDs agree. Crossposts that do not satisfy the full evidence are ignored. A malformed unrelated payload is isolated so it cannot block cursor progress. Failures fetching pages do block cursor advancement for that poll.

Message content, embeds, and attachments require Discord's privileged `MESSAGE_CONTENT` access. When those fields have been withheld, the service records/raises an operational error instead of sending a misleading empty email. Runtime API access otherwise needs `VIEW_CHANNEL` and `READ_MESSAGE_HISTORY`; webhook verification additionally needs `MANAGE_WEBHOOKS` in watched channels.

Use Effect 4 services for domain/application logic and adapters, D1 for durable truth, Queues for at-least-once asynchronous delivery, and Resend's idempotency key as a second duplicate guard. Resend keys are only retained for 24 hours, so D1 remains authoritative. Edits are ignored by default; sent messages cannot be recalled after a Discord deletion.

## Consequences

- Typical discovery latency is at most about one minute, without a Gateway session or Durable Object.
- If more than 100 messages accrue, polling must paginate until caught up; no single-page assumption is safe.
- `MANAGE_WEBHOOKS` is a strict-verification requirement, not a polling requirement. If an operator chooses to omit it, strict classification cannot safely fall back to `webhook_id` alone.
- Preview deployments must be isolated from production D1, Queues, Discord secrets, and email sending. CI builds are credential-free.
- A future Gateway source can replace the polling source behind the `AnnouncementSource` interface without changing classification, persistence, rendering, or delivery.

## References

- [Discord Channel Following API](https://discord.com/developers/docs/resources/channel#follow-announcement-channel)
- [Discord webhook types and objects](https://discord.com/developers/docs/resources/webhook#webhook-object-webhook-types)
- [Discord message flags, references, and message history](https://discord.com/developers/docs/resources/message)
- [Discord HTTP Webhook Events](https://docs.discord.com/developers/events/webhook-events)
- [Discord Gateway](https://docs.discord.com/developers/events/gateway)
- [Cloudflare Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Queues](https://developers.cloudflare.com/queues/)
- [Alchemy Workers](https://alchemy.run/cloudflare/compute/workers/)
- [Alchemy D1](https://alchemy.run/cloudflare/data/d1/)
- [Alchemy Queues](https://alchemy.run/cloudflare/queues/)
- [Effect 4](https://effect.website/docs/v4)
- [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)
