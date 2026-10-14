-- The GC's prune reads mail and events by time: an index each, so a prune reads what is old, not the whole store.
CREATE INDEX messages_by_at ON messages (at);
CREATE INDEX events_by_at ON events (at);
