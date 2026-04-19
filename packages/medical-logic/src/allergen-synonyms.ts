/**
 * Allergen synonym normalization (issue #232).
 *
 * Clinicians commonly record allergies using shorthand (PCN, Sulfa, ASA)
 * or brand names (Lovenox, Coumadin) that don't textually match the
 * generic drug names a prescription carries. Without normalization,
 * `allergy: "PCN"` + `medication: "penicillin VK"` slips through the
 * rule-layer cross-check — a class of near-miss this module closes.
 *
 * Strategy: a canonical allergen (generic name or class) has one or
 * more aliases. `normalizeAllergen("PCN")` returns "penicillin";
 * `expandAllergenAliases("PCN")` returns ["PCN", "penicillin",
 * "amoxicillin", "ampicillin"] so rules can test the candidate medication
 * against the expanded set rather than the raw free-text allergen.
 *
 * Scope:
 *  - Antibiotics (penicillins, cephalosporins, sulfonamides, macrolides,
 *    fluoroquinolones, tetracyclines).
 *  - Analgesics (NSAID brands, opioid brands, APAP).
 *  - Anticoagulants (Lovenox, Coumadin).
 *  - Statins, ACE inhibitors, benzodiazepines, contrast media, latex.
 *
 * Out of scope:
 *  - Full SNOMED / RxNorm normalization (the long-term fix; this is
 *    pragmatic free-text coverage until coded inputs are the norm).
 *  - Food / environmental allergens (peanut, pollen) — different matching
 *    surface, not cross-referenced against the medication list.
 */

/**
 * Canonical allergen → list of aliases that should all be treated as the
 * same entity for matching. The first entry in each alias list is the
 * canonical form the normaliser returns.
 *
 * Entries are lowercase; the matcher lowercases incoming strings before
 * lookup so recorded variants like "PCN" or "Lovenox" resolve correctly.
 */
export const ALLERGEN_SYNONYMS: Record<string, string[]> = {
  // ── Antibiotics ─────────────────────────────────────────────────
  penicillin: [
    "penicillin",
    "pcn",
    "pnc",
    "pen",
    "penicillin v",
    "penicillin g",
    "amoxicillin",
    "amox",
    "ampicillin",
    "ampi",
    "augmentin",
    "amoxil",
  ],
  cephalosporin: [
    "cephalosporin",
    "cephalosporins",
    "cef",
    "cephalexin",
    "keflex",
    "cefazolin",
    "ceftriaxone",
    "rocephin",
    "cefuroxime",
    "cefdinir",
    "cefepime",
  ],
  sulfonamide: [
    "sulfonamide",
    "sulfonamides",
    "sulfa",
    "sulfa drugs",
    "sulfamethoxazole",
    "smx",
    "bactrim",
    "septra",
    "sulfadiazine",
    "sulfasalazine",
    "dapsone",
  ],
  macrolide: [
    "macrolide",
    "macrolides",
    "azithromycin",
    "z-pack",
    "zpack",
    "zithromax",
    "erythromycin",
    "clarithromycin",
    "biaxin",
  ],
  fluoroquinolone: [
    "fluoroquinolone",
    "fluoroquinolones",
    "quinolone",
    "cipro",
    "ciprofloxacin",
    "levaquin",
    "levofloxacin",
    "moxifloxacin",
    "avelox",
  ],
  tetracycline: [
    "tetracycline",
    "doxycycline",
    "vibramycin",
    "minocycline",
    "minocin",
  ],

  // ── Analgesics ──────────────────────────────────────────────────
  // AERD tradeoff: aspirin / ASA / acetylsalicylic acid are intentionally
  // folded into the `nsaid` canonical rather than given a standalone class.
  //
  // Why: aspirin-exacerbated respiratory disease (AERD, Samter's triad)
  // means a documented aspirin allergy usually implies cross-reactivity
  // to the NSAID class (classically non-selective NSAIDs; COX-2 agents
  // like celecoxib are often tolerated in AERD but not reliably so).
  // The safest default for a clinical-safety layer is to treat
  // "allergic to aspirin" as "allergic to the NSAID class" — including
  // celecoxib — rather than silently allow ibuprofen/naproxen/celecoxib/
  // etc. Narrower COX-2 tolerance is a clinician-reviewed decision, not
  // a synonym-layer default.
  //
  // Tradeoff: patients with true isolated aspirin hypersensitivity (not
  // AERD, not NSAID-class cross-reactive) will be over-flagged on other
  // NSAIDs. The override-suppression mechanism in
  // services/ai-oversight/src/rules/allergy-medication.ts handles the
  // "clinician reviewed, approved, proceed" workflow for those patients.
  //
  // If a future policy splits aspirin into its own canonical, the
  // migration path is: (1) add `aspirin: ["aspirin","asa",...]` here,
  // (2) remove aspirin aliases from the `nsaid` entry, (3) move AERD
  // cross-reactivity coverage to a rule-layer cross-reactivity map so
  // it's not silently baked into synonym normalization.
  //
  // Ref: Szczeklik & Stevenson, "Aspirin-induced asthma: advances in
  // pathogenesis, diagnosis, and management" (J Allergy Clin Immunol).
  nsaid: [
    "nsaid",
    "nsaids",
    "ibuprofen",
    "motrin",
    "advil",
    "naproxen",
    "aleve",
    "naprosyn",
    "aspirin",
    "asa",
    "acetylsalicylic acid",
    "celecoxib",
    "celebrex",
    "diclofenac",
    "voltaren",
    "meloxicam",
    "mobic",
    "ketorolac",
    "toradol",
    "indomethacin",
  ],
  acetaminophen: [
    "acetaminophen",
    "apap",
    "paracetamol",
    "tylenol",
    "panadol",
  ],
  opioid: [
    "opioid",
    "opioids",
    "opiate",
    "opiates",
    "morphine",
    "ms contin",
    "roxanol",
    "codeine",
    "tylenol 3",
    "oxycodone",
    "oxycontin",
    "percocet",
    "roxicodone",
    "hydrocodone",
    "vicodin",
    "norco",
    "lortab",
    "fentanyl",
    "duragesic",
    "hydromorphone",
    "dilaudid",
    "tramadol",
    "ultram",
    "meperidine",
    "demerol",
  ],

  // ── Anticoagulants ─────────────────────────────────────────────
  heparin: [
    "heparin",
    "unfractionated heparin",
    "ufh",
    "lmwh",
    "low-molecular-weight heparin",
    "enoxaparin",
    "lovenox",
    "dalteparin",
    "fragmin",
  ],
  warfarin: ["warfarin", "coumadin", "jantoven"],

  // ── Cardiovascular ─────────────────────────────────────────────
  "ace inhibitor": [
    "ace inhibitor",
    "ace-i",
    "acei",
    "lisinopril",
    "enalapril",
    "vasotec",
    "ramipril",
    "altace",
    "captopril",
    "benazepril",
    "lotensin",
    "quinapril",
    "accupril",
    "fosinopril",
    "monopril",
  ],
  statin: [
    "statin",
    "statins",
    "atorvastatin",
    "lipitor",
    "simvastatin",
    "zocor",
    "rosuvastatin",
    "crestor",
    "pravastatin",
    "pravachol",
    "lovastatin",
    "mevacor",
  ],

  // ── Other ──────────────────────────────────────────────────────
  benzodiazepine: [
    "benzodiazepine",
    "benzodiazepines",
    "benzo",
    "benzos",
    "diazepam",
    "valium",
    "lorazepam",
    "ativan",
    "alprazolam",
    "xanax",
    "clonazepam",
    "klonopin",
    "midazolam",
    "versed",
    "temazepam",
    "restoril",
  ],
  "iodinated contrast": [
    "iodinated contrast",
    "iv contrast",
    "contrast dye",
    "iodine",
    "iohexol",
    "omnipaque",
    "iopamidol",
    "iodixanol",
    "visipaque",
  ],
  latex: ["latex", "natural rubber latex"],
};

/**
 * Reverse index: alias (lowercase) → canonical form. Built once at module
 * load and re-used for every lookup.
 */
const ALIAS_TO_CANONICAL: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [canonical, aliases] of Object.entries(ALLERGEN_SYNONYMS)) {
    for (const alias of aliases) {
      out[alias] = canonical;
    }
    // Make the canonical resolve to itself if absent from the alias list.
    if (!(canonical in out)) out[canonical] = canonical;
  }
  return out;
})();

/**
 * Normalise an allergen free-text string to its canonical class / generic
 * name. Returns the canonical string if the input matches a known alias,
 * otherwise the trimmed/lowercased original input.
 *
 * "PCN" → "penicillin", "Lovenox" → "heparin", "Tylenol" → "acetaminophen",
 * "salmon" → "salmon" (unknown, passes through).
 */
export function normalizeAllergen(freeText: string): string {
  const key = freeText.trim().toLowerCase();
  return ALIAS_TO_CANONICAL[key] ?? key;
}

/**
 * Expand an allergen free-text string into every equivalent alias so a
 * matching pass can test the candidate medication against any of them.
 *
 * Returns a deduplicated list including the original input (lowercased),
 * the canonical form, and every other alias of that canonical. Unknown
 * inputs return a single-element list with the lowercased original.
 *
 * Use this when the caller needs to decide "does this medication match
 * this allergy?" — matching any element is a hit.
 */
export function expandAllergenAliases(freeText: string): string[] {
  const key = freeText.trim().toLowerCase();
  const canonical = ALIAS_TO_CANONICAL[key];
  if (!canonical) return [key];
  const aliases = ALLERGEN_SYNONYMS[canonical] ?? [];
  const set = new Set<string>([key, canonical, ...aliases]);
  return Array.from(set);
}
