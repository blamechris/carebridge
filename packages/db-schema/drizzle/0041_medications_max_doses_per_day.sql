-- #935: optional PRN / hard-cap dose count per 24 h on the medications table.
--
-- Populated when a prescription carries an explicit cap (e.g. "morphine 10 mg
-- q4h PRN, max 4 doses/day"). Consumed by the ai-oversight worker via
-- buildPatientContextForRules so PatientMedication.max_doses_per_day flows
-- into estimateDailyDose and the PRN bound actually applies end-to-end.

ALTER TABLE medications ADD COLUMN IF NOT EXISTS max_doses_per_day integer;
