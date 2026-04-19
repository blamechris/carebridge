/**
 * Max single-dose and daily-cumulative-dose reference data (issue #238).
 *
 * Replaces the prior generic 10,000-mg fall-through in validateMedicationDose
 * (10–100× above real safe limits) with drug-specific ceilings sourced from
 * FDA labels and the CDC 2022 opioid prescribing guideline.
 *
 * Scope:
 *  - Acetaminophen, ibuprofen, naproxen, aspirin, diclofenac, meloxicam,
 *    celecoxib — NSAID / analgesic ceilings.
 *  - Morphine, oxycodone, hydrocodone, codeine, tramadol — oral opioid
 *    ceilings keyed off CDC MME guidance (90 MME/day is the elevated-risk
 *    threshold; most per-day caps in this table are calibrated to that).
 *
 * Out of scope (handled in follow-ups):
 *  - Route-specific caps (IV morphine vs PO morphine have very different
 *    safe ceilings). All values here are PO unless noted.
 *  - Transdermal fentanyl patches (expressed as mcg/hr, not mg) — the MME
 *    conversion requires route-aware handling.
 *  - Daily-cumulative summation across multiple prescriptions (issue #235).
 *
 * All values are adult dosing. Pediatric weight-based dosing is handled by
 * weight-based-dosing.ts.
 */

export interface MedicationDoseLimit {
  /** Human-readable canonical name used in validation messages. */
  display_name: string;
  /** Hard ceiling for a single administered dose, in mg (PO unless noted). */
  max_single_dose_mg?: number;
  /**
   * Soft threshold for a single dose. Values above this warn ("verify")
   * but below max_single_dose_mg do not error. Typical use: 650 mg for
   * acetaminophen — legal but above the usual 325–500 mg prescribed dose.
   */
  warn_single_dose_mg?: number;
  /** Max cumulative dose per 24 h in mg. Consumed by daily-sum rules (#235). */
  max_daily_dose_mg?: number;
  /**
   * Morphine Milligram Equivalent factor (PO, oral). Opioid doses multiply
   * by this to compare to the 90 MME/day elevated-risk threshold. Absent on
   * non-opioids.
   */
  mme_factor?: number;
  /** Authoritative source the limit is drawn from. */
  source: string;
}

/**
 * Canonical drug → dose limits. Keys are lowercase generic names; brand
 * names are resolved via {@link DRUG_NAME_ALIASES}.
 */
export const MEDICATION_MAX_DAILY_DOSES: Record<string, MedicationDoseLimit> = {
  // ── NSAIDs / analgesics ─────────────────────────────────────────
  acetaminophen: {
    display_name: "Acetaminophen",
    max_single_dose_mg: 1000,
    warn_single_dose_mg: 650,
    max_daily_dose_mg: 4000,
    source: "FDA label (McNeil, 2011 max-daily reduction)",
  },
  ibuprofen: {
    display_name: "Ibuprofen",
    max_single_dose_mg: 800,
    warn_single_dose_mg: 400,
    max_daily_dose_mg: 3200,
    source: "FDA label (prescription strength)",
  },
  naproxen: {
    display_name: "Naproxen",
    max_single_dose_mg: 1000,
    warn_single_dose_mg: 500,
    max_daily_dose_mg: 1500,
    source: "FDA label (Naprosyn)",
  },
  aspirin: {
    display_name: "Aspirin",
    max_single_dose_mg: 1000,
    warn_single_dose_mg: 650,
    max_daily_dose_mg: 4000,
    source: "FDA OTC monograph (analgesic dosing)",
  },
  diclofenac: {
    display_name: "Diclofenac",
    max_single_dose_mg: 50,
    max_daily_dose_mg: 150,
    source: "FDA label (Voltaren IR)",
  },
  meloxicam: {
    display_name: "Meloxicam",
    max_single_dose_mg: 15,
    max_daily_dose_mg: 15,
    source: "FDA label (Mobic)",
  },
  celecoxib: {
    display_name: "Celecoxib",
    max_single_dose_mg: 200,
    max_daily_dose_mg: 400,
    source: "FDA label (Celebrex)",
  },

  // ── Oral opioids (PO). Daily caps are calibrated to CDC 2022 90 MME/day.
  morphine: {
    display_name: "Morphine (PO)",
    max_single_dose_mg: 30,
    max_daily_dose_mg: 90,
    mme_factor: 1.0,
    source: "CDC 2022 opioid prescribing guideline",
  },
  oxycodone: {
    display_name: "Oxycodone (PO)",
    max_single_dose_mg: 20,
    max_daily_dose_mg: 60,
    mme_factor: 1.5,
    source: "CDC 2022 opioid prescribing guideline",
  },
  hydrocodone: {
    display_name: "Hydrocodone (PO)",
    max_single_dose_mg: 10,
    max_daily_dose_mg: 90,
    mme_factor: 1.0,
    source: "CDC 2022 opioid prescribing guideline",
  },
  codeine: {
    display_name: "Codeine (PO)",
    max_single_dose_mg: 60,
    max_daily_dose_mg: 360,
    mme_factor: 0.15,
    source: "CDC 2022 opioid prescribing guideline",
  },
  tramadol: {
    display_name: "Tramadol (PO)",
    max_single_dose_mg: 100,
    max_daily_dose_mg: 400,
    mme_factor: 0.2,
    source: "FDA label (Ultram) and CDC 2022",
  },
};

/**
 * Brand → generic aliases. Combo products (e.g. Percocet = oxycodone +
 * acetaminophen) are aliased to the opioid component — the more tightly
 * bounded drug — so the lookup returns the stricter of the two caps.
 */
const DRUG_NAME_ALIASES: Record<string, string> = {
  // Acetaminophen
  tylenol: "acetaminophen",
  apap: "acetaminophen",
  paracetamol: "acetaminophen",
  panadol: "acetaminophen",
  // Ibuprofen
  advil: "ibuprofen",
  motrin: "ibuprofen",
  nuprin: "ibuprofen",
  // Naproxen
  aleve: "naproxen",
  naprosyn: "naproxen",
  anaprox: "naproxen",
  // Aspirin
  bayer: "aspirin",
  asa: "aspirin",
  bufferin: "aspirin",
  ecotrin: "aspirin",
  // Diclofenac
  voltaren: "diclofenac",
  cataflam: "diclofenac",
  // Meloxicam
  mobic: "meloxicam",
  // Celecoxib
  celebrex: "celecoxib",
  // Opioids
  "ms contin": "morphine",
  ms_contin: "morphine",
  mscontin: "morphine",
  roxanol: "morphine",
  kadian: "morphine",
  oxycontin: "oxycodone",
  percocet: "oxycodone", // oxycodone + APAP; opioid is the tighter guard
  roxicodone: "oxycodone",
  oxyir: "oxycodone",
  norco: "hydrocodone",
  vicodin: "hydrocodone", // hydrocodone + APAP
  lortab: "hydrocodone",
  zohydro: "hydrocodone",
  ultram: "tramadol",
  tylenol3: "codeine",
  "tylenol 3": "codeine",
};

/**
 * Look up per-drug dose limits by free-text drug name. Matches lowercase,
 * trimmed name against the canonical table and the brand-name alias map.
 * Returns undefined when the drug is unknown — callers should fall back
 * to a generic ceiling.
 */
export function getMedicationDoseLimit(
  drugName: string,
): MedicationDoseLimit | undefined {
  const key = drugName.trim().toLowerCase();
  if (MEDICATION_MAX_DAILY_DOSES[key]) return MEDICATION_MAX_DAILY_DOSES[key];
  const canonical = DRUG_NAME_ALIASES[key];
  if (canonical) return MEDICATION_MAX_DAILY_DOSES[canonical];
  return undefined;
}
