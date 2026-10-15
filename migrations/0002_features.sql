-- Feature wave: shopping categories/photos, task scheduling/blocking, chat media/pins, media table.
ALTER TABLE items ADD COLUMN category TEXT;
ALTER TABLE items ADD COLUMN photo_key TEXT;

ALTER TABLE tasks ADD COLUMN due_time TEXT;          -- HH:MM
ALTER TABLE tasks ADD COLUMN remind_at INTEGER;      -- ms epoch
ALTER TABLE tasks ADD COLUMN reminded_at INTEGER;    -- ms epoch
ALTER TABLE tasks ADD COLUMN recur TEXT;             -- JSON
ALTER TABLE tasks ADD COLUMN slot TEXT;              -- NULL | 'morning' | 'afternoon' | 'evening' (enforced in app code)
ALTER TABLE tasks ADD COLUMN series_id TEXT;
ALTER TABLE tasks ADD COLUMN done_photo_key TEXT;
ALTER TABLE tasks ADD COLUMN blocked_at INTEGER;
ALTER TABLE tasks ADD COLUMN blocked_by TEXT;
ALTER TABLE tasks ADD COLUMN blocked_reason TEXT;
CREATE INDEX idx_tasks_remind_at ON tasks(remind_at);
CREATE INDEX idx_tasks_series_id ON tasks(series_id);

ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN media_key TEXT;
ALTER TABLE messages ADD COLUMN media_meta TEXT;     -- JSON
ALTER TABLE messages ADD COLUMN pinned_at INTEGER;
ALTER TABLE messages ADD COLUMN pinned_by TEXT;

ALTER TABLE members ADD COLUMN chat_read_at INTEGER;

CREATE TABLE media (
  key TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  attached INTEGER NOT NULL DEFAULT 0
);
