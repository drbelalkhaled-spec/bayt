-- Chat: reply to a message (quote) and one emoji reaction per person per message.
ALTER TABLE messages ADD COLUMN reply_to TEXT;

CREATE TABLE message_reactions (
  message_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (message_id, member_id)
);
