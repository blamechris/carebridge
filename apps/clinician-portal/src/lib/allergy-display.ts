/**
 * Allergy display decision logic for the patient overview tab.
 *
 * Clinical safety: a failed allergies fetch must NEVER render as "NKDA".
 * Historically the overview tab defaulted `allergies` to `[]` when the query
 * was `isError`, then rendered "NKDA" on empty — silently misrepresenting
 * documented allergies (e.g., penicillin) as "no known drug allergies" and
 * inviting a contraindicated prescription.
 *
 * This module encodes the five distinct states the UI must render:
 *   - loading
 *   - error (query failed — show unavailable indicator, NOT NKDA)
 *   - populated (allergies present — render the list)
 *   - empty + allergy_status === "nkda"         — confirmed NKDA
 *   - empty + allergy_status === "unknown"      — never assessed
 *   - empty + allergy_status === "has_allergies"— documented gap
 *
 * The semantics mirror `formatAllergies()` in
 * `packages/ai-prompts/src/clinical-review.ts` so the clinician UI and the
 * LLM reviewer agree on what an empty list means.
 */

export type AllergyStatus = "nkda" | "unknown" | "has_allergies";

const VALID_ALLERGY_STATUSES: ReadonlySet<string> = new Set<string>([
  "nkda",
  "unknown",
  "has_allergies",
]);

/**
 * Runtime guard for allergy_status values coming from the DB or API.
 * Returns null for any value not in the known set so the downstream
 * helper defaults to "unknown" (the clinically safer assumption).
 */
export function parseAllergyStatus(
  value: unknown,
): AllergyStatus | null {
  if (typeof value === "string" && VALID_ALLERGY_STATUSES.has(value)) {
    return value as AllergyStatus;
  }
  return null;
}

export type AllergyDisplayState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "populated";
      allergies: ReadonlyArray<{ allergen: string; reaction?: string | null }>;
    }
  | { kind: "nkda" }
  | { kind: "unknown" }
  | { kind: "has_allergies_undocumented" };

export interface AllergyQueryLike<T> {
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly data: T | undefined;
  readonly error?: { message?: string } | null;
}

/**
 * Derive the render state for the allergies card.
 *
 * Order of checks is load-bearing:
 *   1. isError wins over everything — a failed fetch must never be confused
 *      with "no allergies". If the query errored we surface an unavailable
 *      indicator regardless of stale `data`.
 *   2. isLoading before empty checks — an in-flight query would otherwise
 *      flash "NKDA" on mount while data streams in.
 *   3. Populated list is unambiguous.
 *   4. Empty list + allergy_status drives the three empty variants. Default
 *      to "unknown" when allergy_status is absent — the safer assumption
 *      than "nkda".
 */
export function deriveAllergyDisplayState<
  T extends ReadonlyArray<{ allergen: string; reaction?: string | null }>,
>(
  query: AllergyQueryLike<T>,
  allergyStatus: AllergyStatus | null | undefined,
): AllergyDisplayState {
  if (query.isError) {
    return {
      kind: "error",
      message: query.error?.message ?? "Unknown error",
    };
  }

  if (query.isLoading) {
    return { kind: "loading" };
  }

  const allergies = query.data ?? [];
  if (allergies.length > 0) {
    return { kind: "populated", allergies };
  }

  // Empty list — the meaning depends on allergy_status. Absent status is
  // treated as "unknown" (never assessed), not NKDA. Defaulting to NKDA on
  // missing status is the original bug this module exists to prevent.
  const status: AllergyStatus = allergyStatus ?? "unknown";
  switch (status) {
    case "nkda":
      return { kind: "nkda" };
    case "has_allergies":
      return { kind: "has_allergies_undocumented" };
    case "unknown":
    default:
      return { kind: "unknown" };
  }
}
