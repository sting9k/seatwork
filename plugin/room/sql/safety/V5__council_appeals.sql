-- The chair's appeals: a council member asks the room's own seat whether a candidate goes back.
-- finding names what is appealed, so one finding is asked about once; packet is the evidence sent.
-- Every lookup the store makes has an index.

CREATE TABLE council_appeals (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  reading_id INTEGER NOT NULL,
  member TEXT NOT NULL,
  seat TEXT NOT NULL,
  finding TEXT NOT NULL,
  chair TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'upheld', 'sent_back', 'lapsed')),
  ruled_at TEXT,
  ruled_by TEXT,
  reason TEXT,
  packet TEXT NOT NULL
) STRICT;
CREATE INDEX council_appeals_by_status ON council_appeals (status, due_at);
CREATE INDEX council_appeals_by_finding ON council_appeals (seat, member, finding);
CREATE INDEX council_appeals_by_at ON council_appeals (at);
