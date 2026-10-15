-- The inviter chooses the invitee's name; joining no longer asks for one.
ALTER TABLE invites ADD COLUMN name TEXT;
