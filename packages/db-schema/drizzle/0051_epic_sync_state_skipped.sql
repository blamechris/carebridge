-- #1097: surface soft-skipped Epic sub-resource fetches.
--
-- When the Epic sync worker calls a sub-resource search (e.g.
-- Observation?category=vital-signs) and Epic rejects it with 400
-- "not authorized for this sub-resource" (code 59022), the worker
-- soft-skips it so the rest of the batch still runs. Before this
-- migration that skip was logged at WARN only; operators couldn't
-- tell "we have no data because Epic refused" from "we have no data
-- because the patient has none."
--
-- This column records the most recent batch's skipped sub-resource
-- filters as a JSONB array of {filter: Record<string,string>,
-- reason: "unauthorized"} entries. Cleared each markOk() write so it
-- reflects the latest batch only — historical drift is captured by
-- the BullMQ job logs, not this column.
ALTER TABLE "epic_sync_state"
  ADD COLUMN IF NOT EXISTS "skipped_sub_resources" jsonb NOT NULL DEFAULT '[]'::jsonb;
