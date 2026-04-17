-- GIN index on clinical_flags.trigger_event_ids for replay-safety
-- containment lookups (@>). jsonb_path_ops is smaller and faster than
-- the default jsonb_ops when only @> is used.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_flags_trigger_event_ids
  ON clinical_flags USING gin (trigger_event_ids jsonb_path_ops);
