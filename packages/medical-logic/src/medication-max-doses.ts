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
  displayName: string;
  /** Hard ceiling for a single administered dose, in mg (PO unless noted). */
  maxSingleDoseMg?: number;
  /**
   * Soft threshold for a single dose. Values above this warn ("verify")
   * but below maxSingleDoseMg do not error. Typical use: 650 mg for
   * acetaminophen — legal but above the usual 325–500 mg prescribed dose.
   */
  warnSingleDoseMg?: number;
  /** Max cumulative dose per 24 h in mg. Consumed by daily-sum rules (#235). */
  maxDailyDoseMg?: number;
  /**
   * Morphine Milligram Equivalent factor (PO, oral). Opioid doses multiply
   * by this to compare to the 90 MME/day elevated-risk threshold. Absent on
   * non-opioids.
   */
  mmeFactor?: number;
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
    displayName: "Acetaminophen",
    maxSingleDoseMg: 1000,
    warnSingleDoseMg: 650,
    maxDailyDoseMg: 4000,
    source: "FDA label (McNeil, 2011 max-daily reduction)",
  },
  ibuprofen: {
    displayName: "Ibuprofen",
    maxSingleDoseMg: 800,
    warnSingleDoseMg: 400,
    maxDailyDoseMg: 3200,
    source: "FDA label (prescription strength)",
  },
  naproxen: {
    displayName: "Naproxen",
    maxSingleDoseMg: 1000,
    warnSingleDoseMg: 500,
    maxDailyDoseMg: 1500,
    source: "FDA label (Naprosyn)",
  },
  aspirin: {
    displayName: "Aspirin",
    maxSingleDoseMg: 1000,
    warnSingleDoseMg: 650,
    maxDailyDoseMg: 4000,
    source: "FDA OTC monograph (analgesic dosing)",
  },
  diclofenac: {
    displayName: "Diclofenac",
    maxSingleDoseMg: 50,
    maxDailyDoseMg: 150,
    source: "FDA label (Voltaren IR)",
  },
  meloxicam: {
    displayName: "Meloxicam",
    maxSingleDoseMg: 15,
    maxDailyDoseMg: 15,
    source: "FDA label (Mobic)",
  },
  celecoxib: {
    displayName: "Celecoxib",
    maxSingleDoseMg: 200,
    maxDailyDoseMg: 400,
    source: "FDA label (Celebrex)",
  },

  // ── Oral opioids (PO). Daily caps are calibrated to CDC 2022 90 MME/day.
  morphine: {
    displayName: "Morphine (PO)",
    maxSingleDoseMg: 30,
    maxDailyDoseMg: 90,
    mmeFactor: 1.0,
    source: "CDC 2022 opioid prescribing guideline",
  },
  oxycodone: {
    displayName: "Oxycodone (PO)",
    maxSingleDoseMg: 20,
    maxDailyDoseMg: 60,
    mmeFactor: 1.5,
    source: "CDC 2022 opioid prescribing guideline",
  },
  hydrocodone: {
    displayName: "Hydrocodone (PO)",
    maxSingleDoseMg: 10,
    maxDailyDoseMg: 90,
    mmeFactor: 1.0,
    source: "CDC 2022 opioid prescribing guideline",
  },
  codeine: {
    displayName: "Codeine (PO)",
    maxSingleDoseMg: 60,
    maxDailyDoseMg: 360,
    mmeFactor: 0.15,
    source: "CDC 2022 opioid prescribing guideline",
  },
  tramadol: {
    displayName: "Tramadol (PO)",
    maxSingleDoseMg: 100,
    maxDailyDoseMg: 400,
    mmeFactor: 0.2,
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
 * Strip trailing strength / route / frequency tokens from a free-text
 * drug name so entries like "Ibuprofen 600mg TID" or "Acetaminophen
 * 500mg PO q6h" still resolve to their canonical entry.
 *
 * Heuristic: everything from the first digit onward is clinical-form
 * decoration (strength, frequency, duration), not drug-identity. Drop
 * it, then collapse whitespace. The raw input is also tried so pure-name
 * lookups keep working for inputs like "Tylenol 3" that encode strength
 * as part of the aliased brand key.
 */
function candidatesFor(drugName: string): string[] {
  const raw = drugName.trim().toLowerCase();
  const stripped = raw.replace(/\s*\d.*$/, "").trim().replace(/\s+/g, " ");
  // raw wins first so alias keys that happen to contain digits ("tylenol 3")
  // keep resolving; stripped handles "ibuprofen 600mg tid" style input.
  if (!stripped || stripped === raw) return [raw];
  return [raw, stripped];
}

/**
 * Look up per-drug dose limits by free-text drug name. Accepts
 * generics, brand aliases (case-insensitive), and names with trailing
 * strength / frequency tokens stripped. Returns undefined when the
 * drug is unknown — callers should fall back to a generic ceiling.
 */
export function getMedicationDoseLimit(
  drugName: string,
): MedicationDoseLimit | undefined {
  for (const key of candidatesFor(drugName)) {
    const direct = MEDICATION_MAX_DAILY_DOSES[key];
    if (direct) return direct;
    const canonical = DRUG_NAME_ALIASES[key];
    if (canonical) return MEDICATION_MAX_DAILY_DOSES[canonical];
  }
  return undefined;
}
