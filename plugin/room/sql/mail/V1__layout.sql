-- A project's mail: every message, how each recipient stands with it, what happened to it.
-- Every lookup the store makes has an index.

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  thread TEXT NOT NULL DEFAULT '',
  reply_to INTEGER REFERENCES messages (id) ON DELETE SET NULL,
  sender TEXT NOT NULL,
  sender_role TEXT NOT NULL,
  signal TEXT NOT NULL,
  subject TEXT NOT NULL CHECK (length(subject) <= 200),
  body TEXT NOT NULL,
  file TEXT,
  files TEXT NOT NULL DEFAULT '[]',
  needs TEXT NOT NULL CHECK (needs IN ('nothing', 'reply', 'decision')),
  why TEXT NOT NULL DEFAULT '',
  fingerprint TEXT NOT NULL,
  key TEXT,
  answered_at TEXT,
  answered_by INTEGER
) STRICT;
CREATE INDEX messages_by_thread ON messages (thread, id);
CREATE INDEX messages_by_sender ON messages (sender, id);
CREATE INDEX messages_by_signal ON messages (signal, id);
CREATE INDEX messages_by_print ON messages (sender, fingerprint, at);
CREATE INDEX messages_by_key ON messages (sender, key, at) WHERE key IS NOT NULL;
CREATE INDEX messages_owed ON messages (sender, id) WHERE needs <> 'nothing' AND answered_at IS NULL;

CREATE TABLE deliveries (
  message_id INTEGER NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  seat TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('to', 'cc', 'team')),
  priority TEXT NOT NULL CHECK (priority IN ('blocking', 'action', 'fyi')),
  state TEXT NOT NULL CHECK (state IN ('kept', 'queued', 'sending', 'delivered', 'read', 'bounced', 'replaced', 'withdrawn')),
  quiet INTEGER NOT NULL DEFAULT 0 CHECK (quiet IN (0, 1)),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress IN (0, 1)),
  urgent INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  round TEXT,
  held_until TEXT,
  delivered_at TEXT,
  how TEXT,
  PRIMARY KEY (message_id, seat)
) STRICT, WITHOUT ROWID;
CREATE INDEX deliveries_by_seat ON deliveries (seat, state, message_id);
CREATE INDEX deliveries_by_state ON deliveries (state, seat);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  message_id INTEGER,
  seat TEXT,
  detail TEXT
) STRICT;
CREATE INDEX events_by_kind ON events (kind, at);
CREATE INDEX events_of ON events (message_id, seq);

CREATE VIRTUAL TABLE search USING fts5 (subject, body, tokenize = 'porter unicode61');
