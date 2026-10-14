-- Decisions: what a person with the authority decided, as an English statement, kept in the room's own store.
-- A scope is room, project:<root> or task:<root>:<task>; each topic of a scope has one decision in force,
-- which SQLite holds by a unique index. A decision that is replaced, withdrawn or past its date stays, closed,
-- so the reason for a change is never lost; a temporary one that ends, or one withdrawn, gives the topic back to the
-- decision it replaced. Every lookup the store makes has an index.

-- action: decide records a decision, withdraw closes the one in force on its topic. base_version: the version in
-- force when it was asked for; a pending one whose base moved meanwhile is dropped, not laid over the change.
-- state: pending until the turn it was recorded in ends and its source is found; then active, or applied for a
-- withdrawal, or dropped when no source was found; an active one ends superseded, expired or withdrawn.
CREATE TABLE decisions (
  id INTEGER PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('decide', 'withdraw')),
  scope_key TEXT NOT NULL,
  topic TEXT NOT NULL,
  statement TEXT NOT NULL,
  version INTEGER NOT NULL,
  base_version INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'applied', 'dropped', 'superseded', 'expired', 'withdrawn')),
  recorded_by TEXT NOT NULL,
  needs_person INTEGER NOT NULL CHECK (needs_person IN (0, 1)),
  valid_from TEXT NOT NULL,
  valid_until TEXT,
  supersedes INTEGER REFERENCES decisions (id) ON DELETE SET NULL,
  superseded_by INTEGER REFERENCES decisions (id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT
) STRICT;
CREATE UNIQUE INDEX decisions_in_force ON decisions (scope_key, topic) WHERE state = 'active';
CREATE INDEX decisions_by_scope ON decisions (state, scope_key, valid_from);
CREATE INDEX decisions_pending ON decisions (recorded_by, created_at) WHERE state = 'pending';
CREATE INDEX decisions_closed ON decisions (closed_at) WHERE closed_at IS NOT NULL;
CREATE INDEX decisions_supersedes ON decisions (supersedes) WHERE supersedes IS NOT NULL;
CREATE INDEX decisions_superseded_by ON decisions (superseded_by) WHERE superseded_by IS NOT NULL;

CREATE VIRTUAL TABLE decisions_fts USING fts5(
  topic,
  statement,
  content = 'decisions',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 0'
);
CREATE TRIGGER decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts (rowid, topic, statement) VALUES (new.id, new.topic, new.statement);
END;
CREATE TRIGGER decisions_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts (decisions_fts, rowid, topic, statement) VALUES ('delete', old.id, old.topic, old.statement);
END;

-- the person's own words a decision rests on, copied from the record so they outlive it; any language
CREATE TABLE decision_sources (
  decision_id INTEGER PRIMARY KEY REFERENCES decisions (id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  said_at TEXT NOT NULL,
  text TEXT NOT NULL
) STRICT;
CREATE INDEX decision_sources_by_address ON decision_sources (address);

-- what each seat was shown, so a change reaches the seats that hold an older one, and nothing is shown twice;
-- shown: the id of the decision it saw on the note's topic, so a decision that comes back is a change too
CREATE TABLE shown (
  seat TEXT NOT NULL,
  note TEXT NOT NULL,
  shown INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (seat, note)
) STRICT, WITHOUT ROWID;

-- counts per day, for what the district did and missed
CREATE TABLE tallies (
  day TEXT NOT NULL,
  name TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (day, name)
) STRICT, WITHOUT ROWID;
