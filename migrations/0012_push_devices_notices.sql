-- Every phone/tablet of a member gets pushes; every event keeps its own notice so two quick pushes show two texts.
CREATE TABLE push_devices (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  sub TEXT NOT NULL,            -- JSON {endpoint, keys}
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_push_devices_member ON push_devices(member_id);

-- The single subscription per member (members.push_sub) is no longer used; copy what exists.
INSERT OR IGNORE INTO push_devices(id, member_id, endpoint, sub, created_at)
  SELECT lower(hex(randomblob(16))), id, json_extract(push_sub, '$.endpoint'), push_sub, created_at
  FROM members
  WHERE push_sub IS NOT NULL AND removed_at IS NULL AND json_valid(push_sub) AND json_extract(push_sub, '$.endpoint') IS NOT NULL;

CREATE TABLE notices (
  id TEXT PRIMARY KEY,
  member_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  ref TEXT,                     -- "task:<id>" | "msg:<id>" | "item:<id>"
  at INTEGER NOT NULL           -- ms epoch
);
CREATE INDEX idx_notices_member_at ON notices(member_id, at);
