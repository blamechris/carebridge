-- Migration: Add is_urgent column to notifications
--
-- Critical and high-severity clinical flags require urgent attention.
-- This column allows the UI to surface urgent notifications prominently
-- (visual priority, sound alerts, bypass quiet hours).

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_urgent BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_notifications_urgent
  ON notifications (user_id, is_urgent, is_read, created_at);
