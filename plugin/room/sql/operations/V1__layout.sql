-- The room's operations, kept in the room home: its log, the incidents it raised, and every change to its policy.

CREATE TABLE log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  district TEXT NOT NULL,
  line TEXT NOT NULL
) STRICT;
CREATE INDEX log_by_at ON log (at);
CREATE INDEX log_by_district ON log (district, id);

-- one row per kind of trouble: count goes up each time it is seen; told_at and told_count: when and at what count
-- the operator was last mailed about it
CREATE TABLE incidents (
  key TEXT PRIMARY KEY,
  district TEXT NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  count INTEGER NOT NULL,
  line TEXT NOT NULL,
  told_at TEXT,
  told_count INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;
CREATE INDEX incidents_by_last ON incidents (last_at);

-- a change to the policy: the value before and after as JSON, what was measured first, and the change it undoes
CREATE TABLE tunes (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  seat TEXT NOT NULL,
  path TEXT NOT NULL,
  before TEXT,
  after TEXT,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  reverts INTEGER
) STRICT;
CREATE INDEX tunes_by_path ON tunes (path, id);
CREATE INDEX tunes_by_at ON tunes (at);
