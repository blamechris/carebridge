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
