-- Urgent tasks jump to the top and always ring; questions are short threads on a task.
ALTER TABLE tasks ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;

CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_task_comments_task ON task_comments(task_id, created_at);
