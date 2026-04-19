/**
 * Shared drug-name regex patterns used across multiple rule modules.
 *
 * Previously, `cross-specialty.ts` (CROSS-METFORMIN-GFR-001) carried a broad
 * metformin pattern that covered branded fixed-dose combination products
 * (Janumet, Jentadueto, Synjardy, etc.) while `drug-interactions.ts`
 * (DI-METFORMIN-CONTRAST) carried a narrower one limited to `/metformin|glucophage/`.
 * The narrower pattern missed patients on combo products during contrast
 * administration — a real clinical miss. Issue #865.
 *
 * The single source of truth lives here so both consumers stay in lockstep as
 * new branded combinations are added.
 */

/**
 * Metformin name pattern (generic + brand combinations). Includes fixed-dose
 * combination brand names commonly prescribed in type 2 diabetes, so rules
 * fire regardless of whether the EHR records "metformin" plainly or the
 * branded combo. Extend cautiously — additions should come from FDA-approved
 * metformin-containing combination products.
 */
export const METFORMIN_PATTERN =
  /\bmetformin\b|glucophage|glumetza|fortamet|riomet|janumet|jentadueto|kombiglyze|synjardy|xigduo|invokamet|kazano|prandimet/i;

/**
 * NSAID name pattern (non-steroidal anti-inflammatory drugs). Unified source
 * for rules in multiple modules that gate on NSAID exposure — previously this
 * list was duplicated between `cross-specialty.ts` (triple-whammy AKI,
 * CROSS-NSAID-CHF-001) and `age-stratified.ts` (Beers geriatric chronic
 * NSAID). Issue #903.
 *
 * Broader (no word boundaries) is intentional: clinical free-text medication
 * strings occasionally carry the drug name without a leading or trailing
 * word-boundary character (e.g. "naproxen-sodium", "ibuprofen/pseudoephedrine
 * combo"), and NSAID exposure must still trigger safety rules in those cases.
 * Celecoxib is included because despite being COX-2 selective it still
 * carries the renal-perfusion and fluid-retention risks targeted by these
 * rules.
 *
 * Extend cautiously — additions should come from FDA-approved NSAID generics
 * or brand-name products.
 */
export const NSAID_PATTERN =
  /ibuprofen|advil|motrin|naproxen|aleve|diclofenac|voltaren|celecoxib|celebrex|indomethacin|ketorolac|toradol|meloxicam|piroxicam|nabumetone|etodolac|sulindac|ketoprofen/i;
