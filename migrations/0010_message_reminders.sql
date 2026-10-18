-- Personal "remind me" on a chat message: only the member who set it is notified.
CREATE TABLE message_reminders (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  remind_at INTEGER NOT NULL,   -- ms epoch
  sent_at INTEGER,              -- ms epoch the push went out; NULL = pending
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_message_reminders_member_msg ON message_reminders(member_id, message_id);
CREATE INDEX idx_message_reminders_at ON message_reminders(remind_at);
