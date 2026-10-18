-- Per-person notification choices: JSON {chat, tasks, list, quiet: null | {from, to}}; NULL means the defaults (everything on, no quiet hours).
ALTER TABLE members ADD COLUMN notify_prefs TEXT;
