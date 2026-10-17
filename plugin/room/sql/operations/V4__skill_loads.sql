-- How often each role's seats loaded each skill, a row per UTC day, role and skill; kept as long as days of spend.
CREATE TABLE skill_loads (
  day TEXT NOT NULL,
  role TEXT NOT NULL,
  skill TEXT NOT NULL,
  loads INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, role, skill)
) STRICT, WITHOUT ROWID;
