-- The codes only the person may grant that still wait: the app asks for them every few seconds.
CREATE INDEX codes_for_person ON codes (created_at) WHERE grantor = 'human' AND granted_at IS NULL AND used_at IS NULL;
