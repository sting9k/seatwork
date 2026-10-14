-- A list of issues with no filter is read in the order a seat sees them, from this index, not sorted whole.
CREATE INDEX issues_by_order ON issues (priority, created_at, id);
