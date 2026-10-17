-- App problems: server and screen errors, kept 30 days; parents can opt in to a push about them.
CREATE TABLE error_log (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,       -- ms epoch
  source TEXT NOT NULL,      -- e.g. "POST /api/items", "notifications", "app · Maya"
  message TEXT NOT NULL,
  detail TEXT                -- stack or extra context
);
CREATE INDEX idx_error_log_at ON error_log(at);

ALTER TABLE members ADD COLUMN error_alerts INTEGER NOT NULL DEFAULT 0;
