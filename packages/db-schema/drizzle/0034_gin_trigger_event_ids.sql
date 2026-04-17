-- GIN index on clinical_flags.trigger_event_ids for replay-safety
-- containment lookups (@>). jsonb_path_ops is smaller and faster than
-- the default jsonb_ops when only @> is used.
--
-- NOTE: CONCURRENTLY is intentionally omitted here because Drizzle's
-- migration runner executes each file inside a transaction block, and
-- PostgreSQL does not allow CREATE INDEX CONCURRENTLY within a transaction.
-- For large tables, consider running the index creation manually outside
-- of the migration runner with CONCURRENTLY to avoid locking.
CREATE INDEX IF NOT EXISTS idx_flags_trigger_event_ids
  ON clinical_flags USING gin (trigger_event_ids jsonb_path_ops);
