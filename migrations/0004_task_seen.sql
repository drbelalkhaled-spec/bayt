-- "Seen" step: the helper acknowledges a task before doing it.
ALTER TABLE tasks ADD COLUMN seen_at INTEGER;        -- ms epoch
ALTER TABLE tasks ADD COLUMN seen_by TEXT;
