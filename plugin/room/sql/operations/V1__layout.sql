-- The room's operations, kept in the room home: its log, the incidents it raised, the traces of their causes, and
-- every change to its policy.

-- incident: the incident a line counted under, when it reported trouble
CREATE TABLE log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  district TEXT NOT NULL,
  line TEXT NOT NULL,
  incident INTEGER
) STRICT;
CREATE INDEX log_by_at ON log (at);
CREATE INDEX log_by_district ON log (district, id);
CREATE INDEX log_by_incident ON log (incident, at) WHERE incident IS NOT NULL;

-- one row per kind of trouble. state: open; acknowledged (told again only when it comes twice as often as the
-- `acked_rate` an hour it had then); snoozed until `snoozed_until`; resolved with its cause in `note`, and opened again
-- as `back` when it is seen once more. told_at and told_count: when and at what count the operator was last told
CREATE TABLE incidents (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  district TEXT NOT NULL,
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  count INTEGER NOT NULL,
  line TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'acknowledged', 'snoozed', 'resolved')),
  note TEXT NOT NULL DEFAULT '',
  acked_rate INTEGER NOT NULL DEFAULT 0,
  snoozed_until TEXT,
  back INTEGER NOT NULL DEFAULT 0 CHECK (back IN (0, 1)),
  told_at TEXT,
  told_count INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX incidents_by_last ON incidents (last_at);

-- a change to the policy: the value before and after as JSON, what was measured first, the district's reading when it
-- was made, the trace it serves, and the change it undoes
CREATE TABLE tunes (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  seat TEXT NOT NULL,
  path TEXT NOT NULL,
  before TEXT,
  after TEXT,
  reason TEXT NOT NULL,
  evidence TEXT NOT NULL,
  baseline TEXT NOT NULL,
  trace INTEGER,
  reverts INTEGER
) STRICT;
CREATE INDEX tunes_by_path ON tunes (path, id);
CREATE INDEX tunes_by_at ON tunes (at);
CREATE INDEX tunes_by_trace ON tunes (trace) WHERE trace IS NOT NULL;
CREATE INDEX tunes_by_reverts ON tunes (reverts) WHERE reverts IS NOT NULL;

-- a search for a cause: the incident it follows, the hypothesis it holds now, and how it ended
CREATE TABLE traces (
  id INTEGER PRIMARY KEY,
  incident INTEGER,
  opened_at TEXT NOT NULL,
  seat TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  closed_at TEXT,
  conclusion TEXT
) STRICT;
CREATE INDEX traces_open ON traces (opened_at) WHERE closed_at IS NULL;
CREATE INDEX traces_closed ON traces (closed_at) WHERE closed_at IS NOT NULL;

-- what a trace learned, in order: evidence found, a hypothesis set aside, a hypothesis taken up
CREATE TABLE trace_notes (
  id INTEGER PRIMARY KEY,
  trace INTEGER NOT NULL REFERENCES traces (id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('evidence', 'eliminated', 'hypothesis')),
  text TEXT NOT NULL
) STRICT;
CREATE INDEX trace_notes_by_trace ON trace_notes (trace, id);
