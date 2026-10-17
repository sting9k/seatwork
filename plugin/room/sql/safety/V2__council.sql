-- The council's log: every member's reading of a turn, found or not, the labels that come later,
-- and each member's level and threshold as its labels have set them.
-- Every lookup the store makes has an index.

CREATE TABLE council_readings (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  member TEXT NOT NULL,
  version INTEGER NOT NULL,
  seat TEXT NOT NULL,
  role TEXT,
  task TEXT,
  turn TEXT,
  tier TEXT NOT NULL CHECK (tier IN ('fact', 'juror')),
  zone TEXT NOT NULL CHECK (zone IN ('found', 'grey', 'clear', 'skipped')),
  score REAL,
  ask_id INTEGER,
  level INTEGER NOT NULL,
  shown INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT,
  evidence TEXT
) STRICT;
CREATE INDEX council_by_at ON council_readings (at);
CREATE INDEX council_by_seat ON council_readings (seat, member, fingerprint, shown);

-- member and version repeat the reading's, so a member's labels are read without its readings
CREATE TABLE council_labels (
  id INTEGER PRIMARY KEY,
  reading_id INTEGER NOT NULL REFERENCES council_readings (id) ON DELETE CASCADE,
  member TEXT NOT NULL,
  version INTEGER NOT NULL,
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  value TEXT NOT NULL CHECK (value IN ('right', 'wrong')),
  note TEXT
) STRICT;
CREATE INDEX council_labels_by_reading ON council_labels (reading_id, source);
CREATE INDEX council_labels_by_member ON council_labels (member, version, id);

CREATE TABLE council_members (
  member TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  level INTEGER NOT NULL,
  hi REAL,
  labels INTEGER NOT NULL,
  moved_at TEXT NOT NULL
) STRICT;
