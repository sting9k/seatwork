-- The work a seat handed in, as a digest of its changes since it started, and the last verdict given on it with the digest it was given on.
-- They live on the seat's row, so they go when the seat's start does.
ALTER TABLE seats ADD COLUMN handed_digest TEXT;
ALTER TABLE seats ADD COLUMN verdict TEXT;
ALTER TABLE seats ADD COLUMN verdict_digest TEXT;
