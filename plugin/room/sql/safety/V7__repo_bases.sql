-- The commit each repository stood at when the room first started a seat in it: a script that differs from it is the seats' own work, read by the guard when it runs.
-- seen_at moves at each start there, so a repository the room left goes as its seats do.
CREATE TABLE repo_bases (
  common_dir TEXT PRIMARY KEY,
  head TEXT NOT NULL,
  seen_at TEXT NOT NULL
) WITHOUT ROWID;
