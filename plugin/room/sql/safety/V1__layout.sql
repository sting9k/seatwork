-- The safety store: what the command guard decided, the one-time codes it gave,
-- each seat's starting commit, and what the hand-in check found.
-- Every lookup the store makes has an index.

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  seat TEXT,
  role TEXT,
  cli TEXT NOT NULL,
  cwd TEXT,
  command TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('allow', 'deny', 'warn', 'log', 'granted', 'unchecked')),
  pack TEXT,
  rule TEXT,
  severity TEXT CHECK (severity IS NULL OR severity IN ('critical', 'high', 'medium', 'low')),
  code TEXT,
  elapsed_us INTEGER NOT NULL
) STRICT;
CREATE INDEX decisions_by_seat ON decisions (seat, rule, at);
CREATE INDEX decisions_by_seat_time ON decisions (seat, at);
CREATE INDEX decisions_by_at ON decisions (at);

CREATE TABLE codes (
  hash TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  seat TEXT,
  cwd TEXT,
  shown TEXT NOT NULL,
  pack TEXT NOT NULL,
  rule TEXT NOT NULL,
  grantor TEXT NOT NULL CHECK (grantor IN ('owner', 'human')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  granted_by TEXT,
  granted_at TEXT,
  used_at TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX codes_by_code ON codes (code, expires_at);
CREATE INDEX codes_by_seat ON codes (seat, created_at);
CREATE INDEX codes_by_expiry ON codes (expires_at);

CREATE TABLE escalations (
  seat TEXT NOT NULL,
  rule TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (seat, rule, at)
) STRICT, WITHOUT ROWID;
CREATE INDEX escalations_by_at ON escalations (at);

CREATE TABLE seats (
  agent_id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  start_head TEXT,
  started_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE TABLE findings (
  seat TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  rule TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('block', 'warn')),
  path TEXT NOT NULL,
  line INTEGER NOT NULL,
  text TEXT NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  ack TEXT,
  acked_at TEXT,
  PRIMARY KEY (seat, fingerprint)
) STRICT, WITHOUT ROWID;
CREATE INDEX findings_by_seen ON findings (seat, last_at);
CREATE INDEX findings_by_last ON findings (last_at);
