/**
 * Shared constants for the phi-sanitizer package.
 *
 * These are intentionally NOT re-exported from the package barrel
 * (`index.ts`) to keep the public API surface minimal.
 */

/** Hard ceiling on the number of flags a single LLM review may produce. */
export const MAX_FLAGS = 50;

/**
 * Threshold at which a single LLM review's flag count is considered
 * "suspiciously high" and a warning is appended to the validation result.
 *
 * Originally 15 when MAX_FLAGS was 20 (see PR #493 history) — i.e. 75% of
 * cap, which reads as "the LLM is approaching the hard ceiling; something
 * may be off (prompt regression, prompt-injection probe, runaway model)."
 *
 * When MAX_FLAGS was raised 20 -> 50, this constant was left at 15, which
 * meant the warning fired at 30% of capacity. At that level a multi-system
 * oncology patient routinely trips the warning, drowning real signal in
 * noise (see issue #511).
 *
 * We re-peg the threshold to the original "near-cap" semantics at ~75%
 * of MAX_FLAGS. floor(50 * 0.75) = 37. Derived from MAX_FLAGS so future
 * cap changes automatically preserve the ratio; the suspicious-count
 * test asserts the numeric value to catch accidental drift.
 */
export const SUSPICIOUS_FLAG_THRESHOLD = Math.floor(MAX_FLAGS * 0.75);
