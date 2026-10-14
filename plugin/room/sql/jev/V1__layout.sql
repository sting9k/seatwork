-- The decision log: every call to the decision provider, every answer it gave,
-- the state it read while that is kept, the labels that come later,
-- and each month's spending kept as a running total.
-- Every lookup the store makes has an index.

CREATE TABLE calls (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  caller TEXT NOT NULL,
  provider TEXT NOT NULL,
  model_asked TEXT NOT NULL,
  model TEXT,
  state_hash TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  usd REAL,
  usd_source TEXT CHECK (usd_source IS NULL OR usd_source IN ('provider', 'price')),
  latency_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  error TEXT
) STRICT;
CREATE INDEX calls_by_at ON calls (at);

-- value: a noul's probability, a choice's confidence, a score; the whole answer is in `answer`
CREATE TABLE asks (
  id INTEGER PRIMARY KEY,
  call_id INTEGER NOT NULL REFERENCES calls (id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('noul', 'choice', 'score')),
  value REAL NOT NULL,
  choice TEXT,
  answer TEXT NOT NULL
) STRICT;
CREATE INDEX asks_by_call ON asks (call_id);
CREATE INDEX asks_by_question ON asks (question);

CREATE TABLE states (
  hash TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  text TEXT NOT NULL
) STRICT;
CREATE INDEX states_by_at ON states (at);

CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  ask_id INTEGER NOT NULL REFERENCES asks (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  value TEXT NOT NULL,
  note TEXT
) STRICT;
CREATE INDEX labels_by_ask ON labels (ask_id);

CREATE TABLE spend (
  month TEXT PRIMARY KEY,
  usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0
) STRICT;
