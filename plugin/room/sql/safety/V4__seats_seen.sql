-- A seat's start is kept while the seat is seen: a seat removed without an archive goes with the rest of the records.
ALTER TABLE seats ADD COLUMN seen_at TEXT NOT NULL DEFAULT '';
UPDATE seats SET seen_at = started_at;
CREATE INDEX seats_by_seen ON seats (seen_at);
