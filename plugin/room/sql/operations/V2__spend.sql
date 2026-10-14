-- What each project's seats spend, a row per project and UTC day, and the projects the breaker holds past their cap.
-- The project '' counts the room's own seats and seats in no project; no cap applies to it.

-- usd: dollars as the agent CLIs report them; turns: turns that ended
CREATE TABLE spend (
  project TEXT NOT NULL,
  day TEXT NOT NULL,
  usd REAL NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project, day)
) STRICT, WITHOUT ROWID;
CREATE INDEX spend_by_day ON spend (day);

-- a seat's total as last read, from which the cost of its next turn is taken
CREATE TABLE spend_seats (
  seat TEXT PRIMARY KEY,
  total REAL NOT NULL,
  at TEXT NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX spend_seats_by_at ON spend_seats (at);

-- a project held for a UTC day; told: its operators and top seat were told of the hold
CREATE TABLE holds (
  project TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  since TEXT NOT NULL,
  reason TEXT NOT NULL,
  told INTEGER NOT NULL DEFAULT 0 CHECK (told IN (0, 1))
) STRICT, WITHOUT ROWID;
CREATE INDEX holds_by_day ON holds (day);
