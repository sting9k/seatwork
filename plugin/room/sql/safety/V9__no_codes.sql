-- The guard stops no call: it gives no codes and reports no repeats, its record says only what a rule held for, and the record is read only by age.
DROP TABLE codes;
DROP TABLE escalations;
DROP INDEX decisions_by_seat;
DROP INDEX decisions_by_seat_time;
ALTER TABLE decisions DROP COLUMN verdict;
ALTER TABLE decisions DROP COLUMN code;
