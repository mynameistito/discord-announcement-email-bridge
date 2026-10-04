PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  destination_guild_id TEXT NOT NULL,
  destination_channel_id TEXT NOT NULL,
  source_guild_id TEXT,
  source_channel_id TEXT,
  email_to TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (destination_guild_id, destination_channel_id, email_to)
);

CREATE TABLE IF NOT EXISTS channel_cursors (
  subscription_id TEXT PRIMARY KEY REFERENCES subscriptions(id) ON DELETE CASCADE,
  last_message_id TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  discord_message_id TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  source_channel_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  follower_webhook_id TEXT NOT NULL,
  normalized_payload TEXT NOT NULL,
  message_created_at TEXT NOT NULL,
  edited_at TEXT,
  discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (subscription_id, discord_message_id)
);

CREATE INDEX IF NOT EXISTS announcements_discovered_idx ON announcements(discovered_at);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'queued', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  resend_email_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  UNIQUE (announcement_id, recipient)
);

CREATE INDEX IF NOT EXISTS deliveries_pending_idx ON deliveries(status, created_at);
