import { describe, it, expect } from "vitest";
import {
  deriveAllergyDisplayState,
  type AllergyQueryLike,
} from "../lib/allergy-display";

type Allergy = { allergen: string; reaction?: string | null };

function makeQuery(
  overrides: Partial<AllergyQueryLike<Allergy[]>>,
): AllergyQueryLike<Allergy[]> {
  return {
    isLoading: false,
    isError: false,
    data: undefined,
    error: null,
    ...overrides,
  };
}

/**
 * Issue #218: the overview tab rendered "NKDA" whenever the allergies
 * query returned no data, including the `isError` path. This file nails
 * down the contract that the render-state helper MUST produce an error
 * kind (not NKDA) on fetch failure, and distinguishes the three empty
 * variants from each other.
 */
describe("deriveAllergyDisplayState", () => {
  it("returns error (NOT nkda) when the query failed", () => {
    const state = deriveAllergyDisplayState(
      makeQuery({ isError: true, error: { message: "network" } }),
      "nkda",
    );
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.message).toBe("network");
    }
  });

  it("error kind wins even if stale data is present", () => {
    // If a previous fetch succeeded and was cached, the tRPC hook can have
    // isError === true AND data !== undefined. The error must still take
    // precedence so the clinician is not shown a stale allergy list that
    // they mistake for the current picture.
    const state = deriveAllergyDisplayState(
      makeQuery({
        isError: true,
        data: [{ allergen: "penicillin" }],
        error: { message: "boom" },
      }),
      "has_allergies",
    );
    expect(state.kind).toBe("error");
  });

  it("returns loading while the query is in flight", () => {
    const state = deriveAllergyDisplayState(
      makeQuery({ isLoading: true }),
      "nkda",
    );
    expect(state.kind).toBe("loading");
  });

  it("returns populated when the query resolves with allergies", () => {
    const data: Allergy[] = [
      { allergen: "penicillin", reaction: "anaphylaxis" },
      { allergen: "peanuts", reaction: null },
    ];
    const state = deriveAllergyDisplayState(makeQuery({ data }), "has_allergies");
    expect(state.kind).toBe("populated");
    if (state.kind === "populated") {
      expect(state.allergies).toEqual(data);
    }
  });

  it("returns nkda when data is empty and allergy_status is 'nkda'", () => {
    const state = deriveAllergyDisplayState(makeQuery({ data: [] }), "nkda");
    expect(state.kind).toBe("nkda");
  });

  it("returns unknown when data is empty and allergy_status is 'unknown'", () => {
    const state = deriveAllergyDisplayState(makeQuery({ data: [] }), "unknown");
    expect(state.kind).toBe("unknown");
  });

  it("returns has_allergies_undocumented when flagged but list is empty", () => {
    const state = deriveAllergyDisplayState(
      makeQuery({ data: [] }),
      "has_allergies",
    );
    expect(state.kind).toBe("has_allergies_undocumented");
  });

  it("defaults to 'unknown' (never 'nkda') when allergy_status is absent", () => {
    // The historical bug: missing allergy_status + empty data rendered
    // "NKDA". The safer default is "unknown" — force the clinician to
    // acknowledge the gap.
    const state = deriveAllergyDisplayState(makeQuery({ data: [] }), null);
    expect(state.kind).toBe("unknown");
  });

  it("defaults to 'unknown' when allergy_status is undefined", () => {
    const state = deriveAllergyDisplayState(makeQuery({ data: [] }), undefined);
    expect(state.kind).toBe("unknown");
  });

  it("error with no message surfaces a fallback string", () => {
    const state = deriveAllergyDisplayState(
      makeQuery({ isError: true, error: null }),
      "nkda",
    );
    expect(state.kind).toBe("error");
    if (state.kind === "error") {
      expect(state.message).toBe("Unknown error");
    }
  });
});
