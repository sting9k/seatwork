-- The gates' records: hand-in HEADs, passed ACCEPTs and DONEs, and every push.
ALTER TABLE seats ADD COLUMN handed_head TEXT;
ALTER TABLE seats ADD COLUMN handed_at TEXT;

CREATE TABLE accepts (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  accepter TEXT NOT NULL,
  task TEXT NOT NULL,
  writer TEXT NOT NULL,
  repo TEXT NOT NULL,
  base TEXT NOT NULL,
  head TEXT NOT NULL,
  digest TEXT NOT NULL,
  commands TEXT NOT NULL,
  done_at TEXT
) STRICT;
CREATE INDEX accepts_open ON accepts (accepter, task) WHERE done_at IS NULL;
CREATE INDEX accepts_covered ON accepts (done_at) WHERE done_at IS NOT NULL;
CREATE INDEX accepts_by_repo ON accepts (repo, id);

CREATE TABLE dones (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  seat TEXT NOT NULL,
  repo TEXT NOT NULL,
  head TEXT NOT NULL
) STRICT;
CREATE INDEX dones_by_at ON dones (at);
CREATE INDEX dones_by_repo ON dones (repo, id);

CREATE TABLE pushes (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  seat TEXT NOT NULL,
  repo TEXT NOT NULL,
  remote TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  uncovered INTEGER NOT NULL
) STRICT;
CREATE INDEX pushes_by_at ON pushes (at);
