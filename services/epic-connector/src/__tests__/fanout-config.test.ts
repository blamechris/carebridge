/**
 * Unit tests for Epic sync fan-out config (#1098).
 *
 * The fan-out config controls which Observation categories and which
 * MedicationRequest status the Epic sync worker fans out over.
 * Defaults match CareBridge's MVP scope; env overrides let an operator
 * widen/narrow the set without code changes (e.g., a primary-care
 * tenant might want `social-history` and `survey` in addition to
 * `vital-signs`).
 */
import { describe, it, expect } from "vitest";
import {
  getObservationCategories,
  getMedicationRequestStatus,
  DEFAULT_OBSERVATION_CATEGORIES,
  DEFAULT_MEDICATION_REQUEST_STATUS,
} from "../sync/fanout-config.js";

describe("getObservationCategories (#1098)", () => {
  it("returns the MVP defaults when EPIC_OBSERVATION_CATEGORIES is unset", () => {
    expect(getObservationCategories({})).toEqual([
      "vital-signs",
      "laboratory",
    ]);
  });

  it("DEFAULT_OBSERVATION_CATEGORIES matches the documented MVP set", () => {
    // Sanity check so a refactor that bumps the default doesn't silently
    // change the value seen by every existing tenant.
    expect(DEFAULT_OBSERVATION_CATEGORIES).toEqual([
      "vital-signs",
      "laboratory",
    ]);
  });

  it("parses a comma-separated env override", () => {
    expect(
      getObservationCategories({
        EPIC_OBSERVATION_CATEGORIES: "vital-signs,social-history,survey",
      }),
    ).toEqual(["vital-signs", "social-history", "survey"]);
  });

  it("trims whitespace around comma-separated entries", () => {
    expect(
      getObservationCategories({
        EPIC_OBSERVATION_CATEGORIES: " vital-signs , laboratory , exam ",
      }),
    ).toEqual(["vital-signs", "laboratory", "exam"]);
  });

  it("drops empty segments (trailing comma, double comma)", () => {
    expect(
      getObservationCategories({
        EPIC_OBSERVATION_CATEGORIES: "vital-signs,,laboratory,",
      }),
    ).toEqual(["vital-signs", "laboratory"]);
  });

  it("falls back to defaults when env is set but contains only whitespace/commas", () => {
    // Mis-configured env (e.g., `EPIC_OBSERVATION_CATEGORIES=,,,`) must
    // not produce an empty fan-out list — that would silently disable
    // Observation sync for the affected tenant. Fall back to defaults.
    expect(
      getObservationCategories({
        EPIC_OBSERVATION_CATEGORIES: "   ,  ,  ",
      }),
    ).toEqual(["vital-signs", "laboratory"]);
  });

  it("falls back to defaults when env is the empty string", () => {
    expect(
      getObservationCategories({ EPIC_OBSERVATION_CATEGORIES: "" }),
    ).toEqual(["vital-signs", "laboratory"]);
  });

  it("deduplicates repeated categories", () => {
    expect(
      getObservationCategories({
        EPIC_OBSERVATION_CATEGORIES: "vital-signs,vital-signs,laboratory",
      }),
    ).toEqual(["vital-signs", "laboratory"]);
  });
});

describe("getMedicationRequestStatus (#1098)", () => {
  it("returns the MVP default 'active' when env is unset", () => {
    expect(getMedicationRequestStatus({})).toBe("active");
  });

  it("DEFAULT_MEDICATION_REQUEST_STATUS matches the documented MVP value", () => {
    expect(DEFAULT_MEDICATION_REQUEST_STATUS).toBe("active");
  });

  it("uses the EPIC_MEDICATION_REQUEST_STATUS override when set", () => {
    expect(
      getMedicationRequestStatus({ EPIC_MEDICATION_REQUEST_STATUS: "on-hold" }),
    ).toBe("on-hold");
  });

  it("trims whitespace around the override", () => {
    expect(
      getMedicationRequestStatus({
        EPIC_MEDICATION_REQUEST_STATUS: "  completed  ",
      }),
    ).toBe("completed");
  });

  it("falls back to the default when env is the empty string", () => {
    expect(
      getMedicationRequestStatus({ EPIC_MEDICATION_REQUEST_STATUS: "" }),
    ).toBe("active");
  });

  it("falls back to the default when env is only whitespace", () => {
    expect(
      getMedicationRequestStatus({ EPIC_MEDICATION_REQUEST_STATUS: "   " }),
    ).toBe("active");
  });
});
