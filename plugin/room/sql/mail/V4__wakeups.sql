-- Timed wake-ups: a seat asks to be woken, or to wake another, at a set time. When it falls due, a row becomes a WAKE mail and is deleted; only pending ones are kept.
-- by: the seat that set it. due: a UTC ISO time, so times compare as text.

CREATE TABLE wakeups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  seat TEXT NOT NULL,
  by TEXT NOT NULL,
  at TEXT NOT NULL,
  due TEXT NOT NULL,
  note TEXT NOT NULL
) STRICT;
CREATE INDEX wakeups_by_due ON wakeups (due);
CREATE INDEX wakeups_by_seat ON wakeups (seat, due);
CREATE INDEX wakeups_by_setter ON wakeups (by, due);
