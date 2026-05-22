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
  /**
   * Short authority label safe for inline warnings (≤ ~40 chars).
   * Examples: "FDA Rx label (Naprosyn)", "CDC 2022 opioid guideline".
   * Consumed by single-dose error messages in validateMedicationDose
   * where space is tight. (#1026)
   */
  source: string;
  /**
   * Full citation: authority + route + population + caveats / arithmetic.
   * Consumed by rationale fields in flag emission (AI-oversight rule
   * rationale, audit trail) where more room is available. Falls back to
   * `source` when omitted. (#1026)
   */
  citation?: string;
}

/**
 * Canonical drug → dose limits. Keys are lowercase generic names; brand
 * names are resolved via {@link DRUG_NAME_ALIASES}.
 */
export const MEDICATION_MAX_DAILY_DOSES: Record<string, MedicationDoseLimit> = {
  // ── NSAIDs / analgesics ─────────────────────────────────────────
  // Acetaminophen daily ceiling is 4000 mg/day, matching the FDA prescription
  // label for adults. Note McNeil voluntarily reduced the OTC Tylenol Extra
  // Strength label to 3000 mg/day in 2011 as a safety margin for consumers
  // self-medicating. CareBridge is a prescribing-safety tool — the clinician
  // ceiling is 4000; the 3000 mg/day OTC figure is not applied here. If a
  // future policy decision prefers the conservative OTC ceiling, drop this
  // to 3000 and update the source string accordingly.
  acetaminophen: {
    displayName: "Acetaminophen",
    maxSingleDoseMg: 1000,
    warnSingleDoseMg: 650,
    maxDailyDoseMg: 4000,
    source: "FDA Rx label (acetaminophen)",
    citation: "FDA prescription label (adult acetaminophen, 4000 mg/day)",
  },
  // Ibuprofen Rx ceiling is 800 mg single / 3200 mg/day. OTC monograph
  // separately caps at 400 mg single / 1200 mg/day for self-medication —
  // CareBridge is prescribing-side, so we encode the Rx ceiling.
  ibuprofen: {
    displayName: "Ibuprofen",
    maxSingleDoseMg: 800,
    warnSingleDoseMg: 400,
    maxDailyDoseMg: 3200,
    source: "FDA Rx label (ibuprofen)",
    citation:
      "FDA prescription label (adult PO ibuprofen, Rx 800 mg single / 3200 mg/day)",
  },
  // Naproxen Rx (Naprosyn) caps at 1000 mg single / 1500 mg/day for acute use,
  // 1000 mg/day chronic. OTC Aleve (naproxen sodium 220 mg) is a separate
  // monograph capped at 660 mg/day — not applied here.
  //
  // Decision (#1028): the encoded ceiling is the looser ACUTE 1500 mg/day. A
  // chronic prescription (RA, OA, ankylosing spondylitis) that exceeds the
  // 1000 mg/day chronic ceiling but stays under 1500 mg/day will NOT flag
  // here. This is a deliberate trade-off until use-context-aware lookup
  // lands (see #927 — route/use-aware getMedicationDoseLimit), because
  // lowering the encoded ceiling to 1000 mg/day would over-flag legitimate
  // acute prescriptions (gout flare, post-op pain) with no signal to
  // distinguish them at the rule layer today.
  naproxen: {
    displayName: "Naproxen",
    maxSingleDoseMg: 1000,
    warnSingleDoseMg: 500,
    maxDailyDoseMg: 1500,
    source: "FDA Rx label (Naprosyn)",
    citation:
      "FDA prescription label (Naprosyn; adult PO naproxen, Rx 1500 mg/day acute — chronic-use 1000 mg/day ceiling NOT enforced here, pending use-context lookup #927)",
  },
  // Aspirin analgesic dosing — 4 g/day is the OTC monograph adult ceiling.
  // Low-dose Rx aspirin (81–325 mg/day) for antiplatelet / cardioprotection
  // is a categorically different indication and is NOT bounded by this entry;
  // the daily cap is a guardrail against analgesic over-dosing.
  aspirin: {
    displayName: "Aspirin",
    maxSingleDoseMg: 1000,
    warnSingleDoseMg: 650,
    maxDailyDoseMg: 4000,
    source: "FDA OTC monograph (aspirin)",
    citation:
      "FDA OTC monograph (adult analgesic aspirin, 4000 mg/day; antiplatelet Rx 81–325 mg is out of scope)",
  },
  // Diclofenac IR (Voltaren) — 50 mg single / 150 mg/day.
  diclofenac: {
    displayName: "Diclofenac",
    maxSingleDoseMg: 50,
    maxDailyDoseMg: 150,
    source: "FDA Rx label (Voltaren IR)",
    citation:
      "FDA prescription label (Voltaren IR; adult PO diclofenac IR, Rx 150 mg/day)",
  },
  // Diclofenac ER (Voltaren XR) — FDA-labelled adult ceiling is 100 mg
  // once-daily. Because the Rx is a once-daily regimen, the single-dose
  // and daily ceilings coincide (both 100 mg). The 100 mg/day cap is
  // stricter than the 150 mg/day IR cap, which is the formulation-aware
  // distinction this entry exists for (#1041).
  "diclofenac er": {
    displayName: "Diclofenac ER",
    maxSingleDoseMg: 100,
    maxDailyDoseMg: 100,
    source: "FDA Rx label (Voltaren XR)",
    citation:
      "FDA prescription label (Voltaren XR; adult PO diclofenac ER, 100 mg once-daily — single = daily ceiling)",
  },
  meloxicam: {
    displayName: "Meloxicam",
    maxSingleDoseMg: 15,
    maxDailyDoseMg: 15,
    source: "FDA Rx label (Mobic)",
    citation:
      "FDA prescription label (Mobic; adult PO meloxicam, Rx 15 mg/day single dose)",
  },
  // Celecoxib — 400 mg/day for adult RA dosing. Acute pain dosing has a
  // loading-dose pattern (400 mg day 1, then 200 mg) not modeled here.
  celecoxib: {
    displayName: "Celecoxib",
    maxSingleDoseMg: 200,
    maxDailyDoseMg: 400,
    source: "FDA Rx label (Celebrex)",
    citation:
      "FDA prescription label (Celebrex; adult PO celecoxib, Rx 200 mg single / 400 mg/day RA dosing)",
  },

  // ── Oral opioids (PO). Daily caps are calibrated to CDC 2022 90 MME/day
  // — the threshold above which clinicians should "carefully reassess
  // evidence of benefits and risks" per the guideline. These are NOT
  // hard FDA-label ceilings; they are the prescribing-safety threshold
  // CareBridge enforces on adult, chronic-pain prescriptions. IV/IM/
  // transdermal routes have different conversion factors and are out of
  // scope (issue #927).
  morphine: {
    displayName: "Morphine (PO)",
    maxSingleDoseMg: 30,
    maxDailyDoseMg: 90,
    mmeFactor: 1.0,
    source: "CDC 2022 opioid guideline",
    citation:
      "CDC 2022 opioid prescribing guideline (adult chronic-pain MME ceiling, PO)",
  },
  oxycodone: {
    displayName: "Oxycodone (PO)",
    maxSingleDoseMg: 20,
    maxDailyDoseMg: 60,
    mmeFactor: 1.5,
    source: "CDC 2022 opioid guideline",
    citation:
      "CDC 2022 opioid prescribing guideline (adult chronic-pain MME ceiling, PO; 60 mg × 1.5 MME = 90 MME)",
  },
  hydrocodone: {
    displayName: "Hydrocodone (PO)",
    maxSingleDoseMg: 10,
    maxDailyDoseMg: 90,
    mmeFactor: 1.0,
    source: "CDC 2022 opioid guideline",
    citation:
      "CDC 2022 opioid prescribing guideline (adult chronic-pain MME ceiling, PO)",
  },
  codeine: {
    displayName: "Codeine (PO)",
    maxSingleDoseMg: 60,
    maxDailyDoseMg: 360,
    mmeFactor: 0.15,
    source: "CDC 2022 opioid guideline",
    citation:
      "CDC 2022 opioid prescribing guideline (adult chronic-pain MME ceiling, PO; 360 mg × 0.15 MME = 54 MME)",
  },
  // Tramadol — FDA Ultram label hard-caps at 400 mg/day; the lower CDC MME
  // threshold of 90 MME would be ~450 mg, so the FDA label is the binding
  // constraint here. Citation credits both.
  tramadol: {
    displayName: "Tramadol (PO)",
    maxSingleDoseMg: 100,
    maxDailyDoseMg: 400,
    mmeFactor: 0.2,
    source: "FDA Rx label (Ultram)",
    citation:
      "FDA prescription label (Ultram; adult PO tramadol, Rx 400 mg/day) + CDC 2022 MME context",
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
  // Diclofenac. IR vs ER resolves to separate entries because the ER
  // ceiling (100 mg/day) is stricter than IR (150 mg/day) — #1041.
  voltaren: "diclofenac",
  cataflam: "diclofenac",
  "voltaren xr": "diclofenac er",
  "voltaren-xr": "diclofenac er",
  "diclofenac xr": "diclofenac er",
  "diclofenac extended-release": "diclofenac er",
  "diclofenac extended release": "diclofenac er",
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
