-- #931: persist structured medication frequency to eliminate runtime
-- re-parsing of medications.frequency on every rule evaluation.
--
-- The column carries either:
--   * the canonical MedFrequency literal ('daily', 'bid', 'tid', 'qid',
--     'q2h', 'q3h', 'q4h', 'q6h', 'q8h', 'q12h', 'weekly', 'monthly',
--     'prn', 'once'); or
--   * 'qNh:<n>' for non-canonical every-N-hours intervals (q5h, q10h,
--     etc.) the parser surfaces as QNHoursFrequency.
--
-- NULL means the writer could not classify the free-text frequency.
-- Counting nulls (via the dashboard work that lands in a follow-up)
-- gives us visibility into the unparseable-frequency long tail — the
-- denominator we need to improve the parser. Until the column is fully
-- backfilled, rules fall back to runtime parsing of the existing
-- `frequency` column (no behavioural regression).

ALTER TABLE medications ADD COLUMN IF NOT EXISTS frequency_structured text;
