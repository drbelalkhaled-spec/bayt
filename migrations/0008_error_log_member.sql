-- Who sent a screen error, so the hourly limit follows the person (names can change).
ALTER TABLE error_log ADD COLUMN member_id TEXT;
CREATE INDEX idx_error_log_member ON error_log(member_id, at);
