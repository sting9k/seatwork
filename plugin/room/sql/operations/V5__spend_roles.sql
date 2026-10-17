-- What each role's seats spend in a project, a row per project, UTC day and role; kept as long as days of spend.
-- out_tokens: the output tokens of the turns that ended, as the agent CLIs report them
CREATE TABLE spend_roles (
  project TEXT NOT NULL,
  day TEXT NOT NULL,
  role TEXT NOT NULL,
  usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  out_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project, day, role)
) STRICT, WITHOUT ROWID;
CREATE INDEX spend_roles_by_day ON spend_roles (day);
