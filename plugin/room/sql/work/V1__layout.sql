-- The work store: issues, what they depend on, comments, an audit trail.
-- Every lookup the store makes has an index.

CREATE TABLE issues (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  description TEXT NOT NULL DEFAULT '',
  design TEXT NOT NULL DEFAULT '',
  acceptance_criteria TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  write_scope TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('open', 'in_progress', 'deferred', 'closed')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 4),
  issue_type TEXT NOT NULL CHECK (issue_type IN ('task', 'bug', 'feature', 'epic', 'chore', 'docs', 'question')),
  assignee TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT,
  closed_by TEXT,
  defer_until TEXT,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
) STRICT;
CREATE INDEX issues_by_status ON issues (status, priority, created_at, id);
CREATE INDEX issues_by_assignee ON issues (assignee, status) WHERE assignee IS NOT NULL;

CREATE TABLE dependencies (
  issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  depends_on_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('blocks', 'parent-child', 'discovered-from', 'related')),
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  PRIMARY KEY (issue_id, depends_on_id, type),
  CHECK (issue_id != depends_on_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX dependencies_by_target ON dependencies (depends_on_id, type, issue_id);
CREATE INDEX dependencies_by_type ON dependencies (type, issue_id, depends_on_id);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX comments_of ON comments (issue_id, id);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues (id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX events_of ON events (issue_id, id);
