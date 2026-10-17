-- "Needed today" on list items, edited chat messages, and a 24-hour trash for undo/restore.
ALTER TABLE items ADD COLUMN urgent_at INTEGER;      -- ms epoch when flagged "needed today"; NULL = not urgent
ALTER TABLE messages ADD COLUMN edited_at INTEGER;   -- ms epoch of the last edit

CREATE TABLE trash (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,          -- 'item' | 'task' | 'message'
  ref_id TEXT NOT NULL,        -- id of the deleted row
  label TEXT NOT NULL,         -- what to show in the trash list
  data TEXT NOT NULL,          -- JSON copy of the row (plus comments/reactions) used to restore it
  media_key TEXT,              -- its photo/voice note, kept until the trash entry expires
  deleted_by TEXT NOT NULL,
  deleted_at INTEGER NOT NULL
);
CREATE INDEX idx_trash_at ON trash(deleted_at);
