-- #1021: drug concentration (mg/mL) for continuous-infusion orders.
--
-- IV / SC infusion prescriptions present dose as a flow rate (mL/hr), not
-- a per-dose mg amount, so the daily-dose rule must convert through the
-- drug's concentration: mg/day = mL/hr × concentration × 24.
--
-- Today concentrations are encoded inline in the drug name string
-- ("Morphine 1 mg/mL IV gtt"). Name-parsing remains the fallback when
-- this column is NULL; the explicit column lets writers attach a
-- machine-readable concentration without relying on free-text parsing.

ALTER TABLE medications ADD COLUMN IF NOT EXISTS concentration_mg_per_ml real;
