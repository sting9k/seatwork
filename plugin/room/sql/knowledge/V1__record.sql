-- The record: what the room's seats did and mailed, as entries a seat can search.
-- A source is one turn of a seat or one mail; its entries are what was typed, said, run, changed or read,
-- with secrets hidden. The full-text index reads the entries; every lookup the store makes has an index.

-- audience: the seats a source was for, comma-separated; outcome: how a turn ended, or a mail's signal
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('turn', 'mail')),
  ref TEXT NOT NULL,
  agent TEXT NOT NULL,
  role TEXT NOT NULL,
  task TEXT NOT NULL,
  started_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  audience TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX sources_by_ref ON sources (kind, ref);
CREATE INDEX sources_by_agent ON sources (agent, started_at);
CREATE INDEX sources_by_task ON sources (task, started_at);
CREATE INDEX sources_by_at ON sources (started_at);

-- kind: owner (typed to the seat by a person), prompt (a brief the seat was started with), say, shell, change,
-- read, tool, mail; a seat's reasoning is not kept.
CREATE TABLE entries (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources (id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owner', 'prompt', 'say', 'shell', 'change', 'read', 'tool', 'mail')),
  text TEXT NOT NULL,
  exit_code INTEGER,
  UNIQUE (source_id, ordinal)
) STRICT;

CREATE VIRTUAL TABLE entries_fts USING fts5(
  text,
  content = 'entries',
  content_rowid = 'id',
  tokenize = 'porter unicode61 remove_diacritics 0'
);
CREATE TRIGGER entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts (rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts (entries_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

-- where a reader of another store stopped: the id of the last mail read
CREATE TABLE cursors (
  name TEXT PRIMARY KEY,
  last INTEGER NOT NULL
) STRICT;
