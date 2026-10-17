-- An appeal names a reading the council kept: one that names none is refused, and a reading that goes takes its appeals with it.
-- SQLite adds a reference only by making the table again; an appeal whose reading is already gone is not copied.
-- The reference has its index, so a reading's delete finds its appeals without reading the table.

CREATE TABLE council_appeals_named (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  reading_id INTEGER NOT NULL REFERENCES council_readings (id) ON DELETE CASCADE,
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
INSERT INTO council_appeals_named (id, at, due_at, reading_id, member, seat, finding, chair, status, ruled_at, ruled_by, reason, packet)
  SELECT a.id, a.at, a.due_at, a.reading_id, a.member, a.seat, a.finding, a.chair, a.status, a.ruled_at, a.ruled_by, a.reason, a.packet
    FROM council_appeals a WHERE EXISTS (SELECT 1 FROM council_readings r WHERE r.id = a.reading_id);
DROP TABLE council_appeals;
ALTER TABLE council_appeals_named RENAME TO council_appeals;
CREATE INDEX council_appeals_by_status ON council_appeals (status, due_at);
CREATE INDEX council_appeals_by_finding ON council_appeals (seat, member, finding);
CREATE INDEX council_appeals_by_at ON council_appeals (at);
CREATE INDEX council_appeals_by_reading ON council_appeals (reading_id);
