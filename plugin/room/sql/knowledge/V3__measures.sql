-- What the district keeps to measure itself before anything more is turned on: searches and what was opened after,
-- and pairs of decisions. Nothing here changes what a seat is told or what is in force.

-- One search: its phrasings, how each matched, and the addresses it found, best first.
CREATE TABLE searches (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  seat TEXT NOT NULL,
  task TEXT NOT NULL,
  phrases TEXT NOT NULL,
  matched TEXT NOT NULL,
  hits TEXT NOT NULL,
  shown INTEGER NOT NULL
) STRICT;
CREATE INDEX searches_by_at ON searches (at);

-- An address the seat read within its next few calls after a search: the relevance a reranker is judged on.
CREATE TABLE search_opens (
  search_id INTEGER NOT NULL REFERENCES searches (id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  rank INTEGER,
  how TEXT NOT NULL CHECK (how IN ('view', 'expand')),
  at TEXT NOT NULL,
  PRIMARY KEY (search_id, address)
) STRICT, WITHOUT ROWID;

-- A new decision beside an older one, its texts kept: repeat, replacement or apart, by the seat and by the model.
CREATE TABLE pairs (
  id INTEGER PRIMARY KEY,
  new_id INTEGER NOT NULL,
  old_id INTEGER NOT NULL,
  new_text TEXT NOT NULL,
  old_text TEXT NOT NULL,
  seat TEXT NOT NULL,
  at TEXT NOT NULL,
  seat_choice TEXT CHECK (seat_choice IN ('duplicate', 'replaces', 'independent')),
  jev_choice TEXT CHECK (jev_choice IN ('duplicate', 'replaces', 'independent')),
  jev_probabilities TEXT,
  ask_id INTEGER,
  labelled INTEGER NOT NULL DEFAULT 0 CHECK (labelled IN (0, 1)),
  UNIQUE (new_id, old_id)
) STRICT;
CREATE INDEX pairs_by_at ON pairs (at);

