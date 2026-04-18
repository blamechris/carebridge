-- Issue #333: configurable appointment reminder notifications.
--
-- Adds two nullable columns to `appointments` that hold the BullMQ job IDs
-- for the 24h-before and 2h-before reminder jobs. The IDs are written by
-- `services/scheduling/src/reminders.ts :: scheduleReminders` immediately
-- after an appointment row is committed, and read again by the cancel path
-- so it can call `job.remove()` to prevent a reminder from firing for a
-- cancelled appointment.
--
-- Two fixed offsets are hardcoded (see issue #333 non-goals — no custom
-- intervals yet), so a separate `appointment_reminders` table would be
-- over-engineered for two rows per appointment.
--
-- Non-destructive: nullable columns, no default, no backfill needed. Existing
-- rows simply have NULL reminder IDs which the cancel path treats as a no-op.

ALTER TABLE "appointments"
  ADD COLUMN IF NOT EXISTS "reminder_24h_job_id" text;

ALTER TABLE "appointments"
  ADD COLUMN IF NOT EXISTS "reminder_2h_job_id" text;
