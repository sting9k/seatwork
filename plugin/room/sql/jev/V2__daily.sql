-- Each day's spending and failures per district, so a district's daily share is read without the call log.

CREATE TABLE spend_daily (
  day TEXT NOT NULL,
  district TEXT NOT NULL,
  usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, district)
) STRICT, WITHOUT ROWID;
