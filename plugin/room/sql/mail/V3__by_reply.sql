-- Deleting a message looks up the messages that reply to it; a report held for its sender's turn end is found without reading every delivery.
CREATE INDEX messages_by_reply ON messages (reply_to) WHERE reply_to IS NOT NULL;
CREATE INDEX deliveries_held ON deliveries (message_id) WHERE state = 'kept' OR (state = 'withdrawn' AND how = 'taken');
