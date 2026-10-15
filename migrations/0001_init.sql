CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('parent','nanny')),
  token_hash TEXT NOT NULL UNIQUE,
  push_sub TEXT,
  created_at INTEGER NOT NULL,
  removed_at INTEGER
);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('parent','nanny')),
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_by TEXT,
  used_at INTEGER
);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  qty TEXT,
  note TEXT,
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  bought_by TEXT,
  bought_at INTEGER
);
CREATE INDEX idx_items_bought_at ON items(bought_at);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  note TEXT,
  assignee_id TEXT,
  due_on TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  done_by TEXT,
  done_at INTEGER
);
CREATE INDEX idx_tasks_done_at ON tasks(done_at);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  author_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_messages_created_at ON messages(created_at);

CREATE TABLE push_log (
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  PRIMARY KEY (member_id, kind)
);

CREATE TABLE config (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
