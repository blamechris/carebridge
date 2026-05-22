-- #1023: prescriber-marked-chronic flag for the medications table.
--
-- CROSS-STEROID-PCP-001 suppresses for the first 28 days of a steroid
-- course because most prescriptions are short bursts (asthma flare, gout,
-- poison ivy, etc.) and tripping prophylaxis warnings for those is
-- expensive noise. But some patients are on lifelong immunosuppression
-- from day 1 — solid-organ transplant, autoimmune disease, GVHD — and
-- the prescriber knows immediately the course is chronic.
--
-- When `chronic = true` the duration gate is bypassed and the PCP-
-- prophylaxis flag fires at prescription time, not four weeks later.
-- Surfaced in flag metadata as `chronic_marked: true` so downstream
-- FP-rate analysis can distinguish prescriber-marked firings from
-- duration-gate firings (extends #976).

ALTER TABLE medications ADD COLUMN IF NOT EXISTS chronic boolean;
