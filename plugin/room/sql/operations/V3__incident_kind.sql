-- What the decision model read an incident as, when it was sure. asked: the incident was put to the model, or needs not be.
ALTER TABLE incidents ADD COLUMN kind TEXT;
ALTER TABLE incidents ADD COLUMN asked INTEGER NOT NULL DEFAULT 0 CHECK (asked IN (0, 1));
UPDATE incidents SET asked = 1;
CREATE INDEX incidents_unasked ON incidents (id) WHERE asked = 0;
