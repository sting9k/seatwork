-- A claim by a seat of the room is a lease: the time after which, with the seat gone, the issue goes back to the board.
-- Only a held issue has one; the index holds those alone, so a pass reads the leases that are due and no other issue.

ALTER TABLE issues ADD COLUMN lease_until TEXT;
CREATE INDEX issues_by_lease ON issues (lease_until) WHERE lease_until IS NOT NULL;
