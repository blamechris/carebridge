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
 *  - Morphine, oxycodone, hydrocodone, codeine, tramadol, hydromorphone —
 *    opioid ceilings keyed off CDC MME guidance (90 MME/day is the
 *    elevated-risk threshold; PO caps in this table are calibrated to that).
 *  - Route-specific opioid ceilings (#927): morphine and hydromorphone have
 *    IV/SC overrides; PO remains the default when no route is supplied.
 *  - Transdermal fentanyl uses a separate mcg/hr → MME conversion path
 *    (see {@link isFentanylTransdermal}) — not modelled in this table.
 *
 * All values are adult dosing. Pediatric weight-based dosing is handled by
 * weight-based-dosing.ts.
 */

import type { MedRoute } from "@carebridge/shared-types";

/**
 * Per-route override for a {@link MedicationDoseLimit}. Sparse: only the
 * fields that differ from the base (PO) entry need to be supplied; lookup
 * merges the override onto the base.
 */
export type DoseLimitRouteOverride = Partial<
  Pick<
    MedicationDoseLimit,
    | "displayName"
    | "maxSingleDoseMg"
    | "warnSingleDoseMg"
    | "maxDailyDoseMg"
    | "mmeFactor"
    | "source"
    | "citation"
  >
>;

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
  /**
   * Per-route overrides (#927). Each key is a {@link MedRoute}; the value
   * is a sparse override of the base entry's fields. Used by
   * {@link getMedicationDoseLimit} when the caller supplies a route — the
   * override is merged on top of the base entry (which is treated as the
   * PO default).
   *
   * Only the opioids that have clinically meaningful route-specific
   * ceilings carry this map: IV/SC morphine, IV/SC hydromorphone. IV
   * fentanyl is treated separately because its concentration depends on
   * the bag-rate path covered by #1021. Other drugs in this table are
   * PO-only therapeutically (NSAIDs, oral opioids without parenteral
   * formulations) and omit the field.
   */
  byRoute?: Partial<Record<MedRoute, DoseLimitRouteOverride>>;
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
  // Morphine has clinically distinct PO and parenteral ceilings (#927).
  // Base entry is PO; byRoute carries IV / SC / IM overrides keyed off the
  // CDC 2022 MME conversion (1 mg IV/IM/SC morphine = 3 PO MME). The
  // IV single-dose cap of 10 mg covers acute-care titration; the daily
  // cap of 30 mg IV maps to the same 90-MME-equivalent ceiling as PO.
  morphine: {
    displayName: "Morphine (PO)",
    maxSingleDoseMg: 30,
    maxDailyDoseMg: 90,
    mmeFactor: 1.0,
    source: "CDC 2022 opioid guideline",
    citation:
      "CDC 2022 opioid prescribing guideline (adult chronic-pain MME ceiling, PO)",
    byRoute: {
      IV: {
        displayName: "Morphine (IV)",
        maxSingleDoseMg: 10,
        maxDailyDoseMg: 30,
        mmeFactor: 3.0,
        source: "CDC 2022 opioid guideline (IV)",
        citation:
          "CDC 2022 opioid prescribing guideline (adult MME ceiling, IV; 1 mg IV = 3 PO MME)",
      },
      IM: {
        displayName: "Morphine (IM)",
        maxSingleDoseMg: 10,
        maxDailyDoseMg: 30,
        mmeFactor: 3.0,
        source: "CDC 2022 opioid guideline (IM)",
        citation:
          "CDC 2022 opioid prescribing guideline (adult MME ceiling, IM; 1 mg IM = 3 PO MME)",
      },
      subcutaneous: {
        displayName: "Morphine (SC)",
        maxSingleDoseMg: 10,
        maxDailyDoseMg: 30,
        mmeFactor: 3.0,
        source: "CDC 2022 opioid guideline (SC)",
        citation:
          "CDC 2022 opioid prescribing guideline (adult MME ceiling, SC; 1 mg SC = 3 PO MME)",
      },
    },
  },
  // Hydromorphone (Dilaudid). PO baseline plus parenteral overrides per
  // CDC MME table: 4 PO MME / mg, 20 IV-IM-SC MME / mg. PO 4 mg / 22.5
  // mg/day matches the 90-MME chronic-pain ceiling; IV / SC 2 mg single,
  // 4.5 mg/day matches the same 90-MME equivalent (4.5 × 20 = 90 MME).
  hydromorphone: {
    displayName: "Hydromorphone (PO)",
    maxSingleDoseMg: 4,
    maxDailyDoseMg: 22.5,
    mmeFactor: 4.0,
    source: "CDC 2022 opioid guideline",
    citation:
      "CDC 2022 opioid prescribing guideline (adult chronic-pain MME ceiling, PO; 22.5 mg × 4 MME = 90 MME)",
    byRoute: {
      IV: {
        displayName: "Hydromorphone (IV)",
        maxSingleDoseMg: 2,
        maxDailyDoseMg: 4.5,
        mmeFactor: 20.0,
        source: "CDC 2022 opioid guideline (IV)",
        citation:
          "CDC 2022 opioid prescribing guideline (adult MME ceiling, IV; 1 mg IV = 20 PO MME)",
      },
      IM: {
        displayName: "Hydromorphone (IM)",
        maxSingleDoseMg: 2,
        maxDailyDoseMg: 4.5,
        mmeFactor: 20.0,
        source: "CDC 2022 opioid guideline (IM)",
        citation:
          "CDC 2022 opioid prescribing guideline (adult MME ceiling, IM; 1 mg IM = 20 PO MME)",
      },
      subcutaneous: {
        displayName: "Hydromorphone (SC)",
        maxSingleDoseMg: 2,
        maxDailyDoseMg: 4.5,
        mmeFactor: 20.0,
        source: "CDC 2022 opioid guideline (SC)",
        citation:
          "CDC 2022 opioid prescribing guideline (adult MME ceiling, SC; 1 mg SC = 20 PO MME)",
      },
    },
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
 *
 * Combo brands ALSO appear in {@link COMBO_OPIOID_APAP_MG} (for the APAP
 * roll-up rule in #926) and are surfaced as
 * {@link ComboBrandInfo} via {@link lookupComboBrand} so the prescriber
 * sees an explicit disambiguation warning at validation time (#929).
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
  dilaudid: "hydromorphone",
  exalgo: "hydromorphone",
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
 * APAP (acetaminophen) content in mg per dose unit for combo opioid
 * products (#926). The opioid component of these combos is captured by
 * DRUG_NAME_ALIASES → opioid-canonical for the stricter single-dose
 * opioid guard. The APAP component is silently ignored by that path
 * because the alias collapses the name to a single canonical entry.
 *
 * This map carries the APAP mg per dose unit for the same brands, so a
 * daily-rollup rule can sum APAP across a patient's whole medication
 * list (combo opioids + plain acetaminophen) against the 4000 mg/day
 * APAP cap.
 *
 * Values reflect the post-2014 FDA standard for combo APAP products
 * (FDA capped combo APAP at 325 mg per dose unit; manufacturers
 * generally landed on 300–325 mg). Per-formulation strengths vary
 * (Percocet 5/325, 7.5/325, 10/325; Norco 5/325, 7.5/325, 10/325; etc.)
 * but the APAP component is standardized within each brand family.
 *
 * Keys are lowercased brand strings; values are the mg of APAP per
 * dose unit (tablet). Unknown brands return undefined and the caller
 * treats the entry as APAP-free.
 */
export const COMBO_OPIOID_APAP_MG: Record<string, number> = {
  percocet: 325,
  roxicet: 325,
  endocet: 325,
  norco: 325,
  vicodin: 300,
  lortab: 325,
  hydrocet: 325,
  "tylenol 3": 300,
  tylenol3: 300,
  "tylenol 4": 300,
  tylenol4: 300,
  "tylenol with codeine": 300,
  ultracet: 325, // tramadol 37.5 + APAP 325
  darvocet: 325, // propoxyphene + APAP — discontinued but historical Rx
};

/**
 * Look up the APAP content (mg per dose unit) for a combo opioid product.
 * Accepts the same free-text input shape as {@link getMedicationDoseLimit}
 * (case-insensitive, tolerates trailing strength / frequency tokens).
 * Returns undefined when the drug isn't a known combo product, signalling
 * "no APAP component to track" for that medication. (#926)
 */
export function getComboApapMg(drugName: string): number | undefined {
  for (const key of candidatesFor(drugName)) {
    const mg = COMBO_OPIOID_APAP_MG[key];
    if (mg !== undefined) return mg;
  }
  return undefined;
}

/**
 * Combo-product identification (#929).
 *
 * Combo brands (Percocet, Vicodin, Norco, Tylenol 3/4, Ultracet, etc.)
 * pack two ingredients into a single dose unit — typically an opioid +
 * acetaminophen. The medications schema stores ONE `dose_amount` /
 * `dose_unit`, so the encoded number can refer to either component.
 *
 * The historical behaviour aliased combo brands to their opioid
 * component because the opioid ceiling is the tighter guard. That is
 * still the right thing to do for safety, but callers who write
 * `dose_amount` intending the APAP component (a real prescriber error
 * surface) would get a silently-mis-validated record.
 *
 * `lookupComboBrand` exposes the combo information so:
 *  - {@link validateMedicationDose} can warn that the brand is a combo
 *    product and the encoded mg is being interpreted as the opioid
 *    component;
 *  - APAP cumulative checks (#926) can read the non-opioid mg without
 *    having to grep the alias table.
 */
export interface ComboBrandInfo {
  /** Canonicalised brand key (lowercase) that matched the input. */
  brand: string;
  /** Opioid canonical name — same as DRUG_NAME_ALIASES[brand]. */
  opioidComponent: string;
  /**
   * Non-opioid co-ingredient. All currently-encoded combo brands pair
   * an opioid with acetaminophen; future combos (e.g. ibuprofen +
   * hydrocodone) would land here.
   */
  nonOpioidComponent: string;
  /** Non-opioid mg per dose unit (from COMBO_OPIOID_APAP_MG). */
  nonOpioidMgPerDose: number;
}

/**
 * Look up combo-product information for a free-text drug name. Returns
 * undefined when the input is a single-ingredient drug or unknown.
 * Combo brands are identified by intersecting DRUG_NAME_ALIASES and
 * COMBO_OPIOID_APAP_MG — anything present in both is a combo.
 */
export function lookupComboBrand(drugName: string): ComboBrandInfo | undefined {
  for (const key of candidatesFor(drugName)) {
    const opioid = DRUG_NAME_ALIASES[key];
    const nonOpioidMg = COMBO_OPIOID_APAP_MG[key];
    if (opioid && nonOpioidMg !== undefined) {
      return {
        brand: key,
        opioidComponent: opioid,
        nonOpioidComponent: "acetaminophen",
        nonOpioidMgPerDose: nonOpioidMg,
      };
    }
  }
  return undefined;
}

/**
 * MME-per-day-per-(mcg/hr) factor for transdermal fentanyl patches
 * (Duragesic) (#1020).
 *
 * Per CDC 2022 opioid prescribing guideline and the FDA Duragesic
 * label, transdermal fentanyl delivers continuously and the
 * conversion to oral morphine equivalent is:
 *
 *   MME/day = (mcg/hr) × 2.4
 *
 * Reference points used by the daily-dose rule:
 *   - 12 mcg/hr → 28.8 MME/day (sub-threshold; common starter)
 *   - 25 mcg/hr → 60 MME/day (under 90 MME cap)
 *   - 37.5 mcg/hr → 90 MME/day (at CDC threshold)
 *   - 50 mcg/hr → 120 MME/day (1.33× cap → critical at default 1.2×)
 *   - 100 mcg/hr → 240 MME/day (2.67× cap → critical)
 *
 * IV/IM fentanyl uses a different conversion factor (route-aware
 * lookup tracked separately in #927/#1021) and is NOT covered here —
 * this helper applies ONLY to the transdermal patch presentation.
 */
export const FENTANYL_TRANSDERMAL_MME_PER_MCG_HR = 2.4;

/**
 * Detect whether a free-text drug name + dose_unit combination is a
 * transdermal fentanyl patch order (#1020). True only when both:
 *   - name matches /fentanyl|duragesic/i, AND
 *   - dose_unit is the patch delivery rate ("mcg/hr" or variants)
 *
 * Returns false for IV/IM fentanyl (which uses "mcg" or "mg" units)
 * or for any non-fentanyl medication. Callers use the boolean to
 * gate the mcg/hr → MME/day conversion.
 */
export function isFentanylTransdermal(
  drugName: string,
  doseUnit: string | null | undefined,
): boolean {
  if (!/fentanyl|duragesic/i.test(drugName)) return false;
  if (!doseUnit) return false;
  // Accept "mcg/hr", "mcg/h", "mcg per hr", "mcg per hour", "ug/hr", "μg/hr".
  // Normalise spaces and "per" tokens; lowercase.
  const unit = doseUnit.toLowerCase().replace(/\s+/g, "").replace(/per/g, "/");
  return /^(mcg|ug|μg)\/h(r|our)?$/.test(unit);
}

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
 *
 * When `route` is supplied and the resolved entry carries a matching
 * `byRoute` override, the override is merged on top of the base entry
 * (#927). PO is the default — omitting `route` or passing `"oral"`
 * returns the base PO ceiling unchanged. Unknown routes (no override
 * registered for the drug) also fall back to the base entry, since the
 * therapeutic ceiling for an unmodelled route is safer-stricter PO than
 * silently dropping the per-drug guard.
 */
export function getMedicationDoseLimit(
  drugName: string,
  route?: MedRoute | string | null,
): MedicationDoseLimit | undefined {
  let base: MedicationDoseLimit | undefined;
  for (const key of candidatesFor(drugName)) {
    const direct = MEDICATION_MAX_DAILY_DOSES[key];
    if (direct) {
      base = direct;
      break;
    }
    const canonical = DRUG_NAME_ALIASES[key];
    if (canonical) {
      base = MEDICATION_MAX_DAILY_DOSES[canonical];
      break;
    }
  }
  if (!base) return undefined;
  if (!route || route === "oral") return base;
  const override = base.byRoute?.[route as MedRoute];
  if (!override) return base;
  return { ...base, ...override };
}
