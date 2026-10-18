-- Routine items nobody ticked by the end of their day: one row per missed date, written when the item rolls over to today.
CREATE TABLE task_misses (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  assignee_id TEXT,
  slot TEXT,
  due_on TEXT NOT NULL,         -- the missed day, 'YYYY-MM-DD'
  created_at INTEGER NOT NULL   -- ms epoch
);
CREATE UNIQUE INDEX idx_task_misses_series_due ON task_misses(series_id, due_on);
CREATE INDEX idx_task_misses_created_at ON task_misses(created_at);
