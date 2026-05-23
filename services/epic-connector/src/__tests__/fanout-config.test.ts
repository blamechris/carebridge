/**
 * Unit tests for Epic sync fan-out config (#1098, #1110, #1111, #1112,
 * #1113).
 *
 * The fan-out config controls which Observation categories and which
 * MedicationRequest status the Epic sync worker fans out over.
 * Defaults match CareBridge's MVP scope; env overrides let an operator
 * widen/narrow the set without code changes.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Capture log.warn calls before fanout-config imports/creates its
// module-level logger. vi.hoisted + vi.mock ensures the spy is in
// place when `createLogger(...)` runs at module load time.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));

vi.mock("@carebridge/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
  }),
}));

const {
  loadFanoutConfig,
  getFanoutConfig,
  resetFanoutConfigCacheForTests,
  getObservationCategories,
  getMedicationRequestStatus,
  DEFAULT_OBSERVATION_CATEGORIES,
  DEFAULT_MEDICATION_REQUEST_STATUS,
  VALID_OBSERVATION_CATEGORIES,
  VALID_MEDICATION_REQUEST_STATUSES,
} = await import("../sync/fanout-config.js");

beforeEach(() => {
  resetFanoutConfigCacheForTests();
  warnSpy.mockClear();
});

describe("loadFanoutConfig — Observation categories (#1098)", () => {
  it("returns the MVP defaults when EPIC_OBSERVATION_CATEGORIES is unset", () => {
    expect(loadFanoutConfig({}).observationCategories).toEqual([
      "vital-signs",
      "laboratory",
    ]);
  });

  it("DEFAULT_OBSERVATION_CATEGORIES matches the documented MVP set", () => {
    // Sanity check so a refactor that bumps the default doesn't
    // silently change the value seen by every existing tenant.
    expect(DEFAULT_OBSERVATION_CATEGORIES).toEqual([
      "vital-signs",
      "laboratory",
    ]);
  });

  it("parses a comma-separated env override", () => {
    expect(
      loadFanoutConfig({
        EPIC_OBSERVATION_CATEGORIES: "vital-signs,social-history,survey",
      }).observationCategories,
    ).toEqual(["vital-signs", "social-history", "survey"]);
  });

  it("trims whitespace around comma-separated entries", () => {
    expect(
      loadFanoutConfig({
        EPIC_OBSERVATION_CATEGORIES: " vital-signs , laboratory , exam ",
      }).observationCategories,
    ).toEqual(["vital-signs", "laboratory", "exam"]);
  });

  it("drops empty segments (trailing comma, double comma)", () => {
    expect(
      loadFanoutConfig({
        EPIC_OBSERVATION_CATEGORIES: "vital-signs,,laboratory,",
      }).observationCategories,
    ).toEqual(["vital-signs", "laboratory"]);
  });

  it("deduplicates repeated categories", () => {
    expect(
      loadFanoutConfig({
        EPIC_OBSERVATION_CATEGORIES: "vital-signs,vital-signs,laboratory",
      }).observationCategories,
    ).toEqual(["vital-signs", "laboratory"]);
  });
});

describe("loadFanoutConfig — Observation empty-fallback warnings (#1111)", () => {
  it("falls back to defaults when env is the empty string", () => {
    const cfg = loadFanoutConfig({ EPIC_OBSERVATION_CATEGORIES: "" });
    expect(cfg.observationCategories).toEqual([
      "vital-signs",
      "laboratory",
    ]);
  });

  it("falls back to defaults when env contains only whitespace/commas", () => {
    const cfg = loadFanoutConfig({
      EPIC_OBSERVATION_CATEGORIES: "   ,  ,  ",
    });
    expect(cfg.observationCategories).toEqual([
      "vital-signs",
      "laboratory",
    ]);
  });

  it("warns when EPIC_OBSERVATION_CATEGORIES is set but parses empty", () => {
    loadFanoutConfig({ EPIC_OBSERVATION_CATEGORIES: "" });
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, meta] = warnSpy.mock.calls[0]!;
    expect(msg).toMatch(/EPIC_OBSERVATION_CATEGORIES/);
    expect(msg).toMatch(/no valid categories|parsed empty/i);
    expect(meta).toMatchObject({ raw: "" });
  });

  it("does NOT warn when env is unset (no operator intent to override)", () => {
    loadFanoutConfig({});
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("loadFanoutConfig — Observation code-set validation (#1110)", () => {
  it("VALID_OBSERVATION_CATEGORIES matches FHIR R4 observation-category", () => {
    // Sanity check on the allow-list. If HL7 extends the value set,
    // updating this list is one place to change.
    expect(VALID_OBSERVATION_CATEGORIES).toEqual(
      new Set([
        "vital-signs",
        "imaging",
        "laboratory",
        "procedure",
        "survey",
        "exam",
        "therapy",
        "activity",
        "social-history",
      ]),
    );
  });

  it("drops unknown codes and warns about them (partial misconfig)", () => {
    const cfg = loadFanoutConfig({
      EPIC_OBSERVATION_CATEGORIES: "vital-signs,foo,laboratory,bar",
    });
    expect(cfg.observationCategories).toEqual(["vital-signs", "laboratory"]);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, meta] = warnSpy.mock.calls[0]!;
    expect(msg).toMatch(/unknown FHIR observation-category/);
    expect(meta).toMatchObject({
      invalidCodes: ["foo", "bar"],
      kept: ["vital-signs", "laboratory"],
    });
  });

  it("falls back to defaults when ALL codes are unknown", () => {
    const cfg = loadFanoutConfig({
      EPIC_OBSERVATION_CATEGORIES: "foo,bar,baz",
    });
    expect(cfg.observationCategories).toEqual([
      "vital-signs",
      "laboratory",
    ]);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [, meta] = warnSpy.mock.calls[0]!;
    expect(meta).toMatchObject({ invalidCodes: ["foo", "bar", "baz"] });
  });

  it("accepts all 9 valid FHIR observation-category codes", () => {
    const all =
      "vital-signs,imaging,laboratory,procedure,survey,exam,therapy,activity,social-history";
    const cfg = loadFanoutConfig({ EPIC_OBSERVATION_CATEGORIES: all });
    expect(cfg.observationCategories).toEqual(all.split(","));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("loadFanoutConfig — MedicationRequest status (#1098, #1110, #1111)", () => {
  it("returns the MVP default 'active' when env is unset", () => {
    expect(loadFanoutConfig({}).medicationRequestStatus).toBe("active");
  });

  it("DEFAULT_MEDICATION_REQUEST_STATUS matches the documented MVP value", () => {
    expect(DEFAULT_MEDICATION_REQUEST_STATUS).toBe("active");
  });

  it("uses the EPIC_MEDICATION_REQUEST_STATUS override when set to a valid code", () => {
    expect(
      loadFanoutConfig({ EPIC_MEDICATION_REQUEST_STATUS: "on-hold" })
        .medicationRequestStatus,
    ).toBe("on-hold");
  });

  it("trims whitespace around the override", () => {
    expect(
      loadFanoutConfig({
        EPIC_MEDICATION_REQUEST_STATUS: "  completed  ",
      }).medicationRequestStatus,
    ).toBe("completed");
  });

  it("warns and falls back when env is the empty string", () => {
    const cfg = loadFanoutConfig({ EPIC_MEDICATION_REQUEST_STATUS: "" });
    expect(cfg.medicationRequestStatus).toBe("active");
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg] = warnSpy.mock.calls[0]!;
    expect(msg).toMatch(/EPIC_MEDICATION_REQUEST_STATUS.*empty/);
  });

  it("warns and falls back when env is only whitespace", () => {
    const cfg = loadFanoutConfig({ EPIC_MEDICATION_REQUEST_STATUS: "   " });
    expect(cfg.medicationRequestStatus).toBe("active");
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("warns and falls back when env is an unknown status code", () => {
    const cfg = loadFanoutConfig({
      EPIC_MEDICATION_REQUEST_STATUS: "in-progress",
    });
    expect(cfg.medicationRequestStatus).toBe("active");
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, meta] = warnSpy.mock.calls[0]!;
    expect(msg).toMatch(/not a known FHIR medication-request-status/);
    expect(meta).toMatchObject({
      raw: "in-progress",
      fallback: "active",
    });
  });

  it("accepts all 8 valid FHIR medication-request-status codes", () => {
    for (const status of VALID_MEDICATION_REQUEST_STATUSES) {
      warnSpy.mockClear();
      const cfg = loadFanoutConfig({
        EPIC_MEDICATION_REQUEST_STATUS: status,
      });
      expect(cfg.medicationRequestStatus).toBe(status);
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });

  it("does NOT warn when env is unset", () => {
    loadFanoutConfig({});
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("getFanoutConfig caching (#1112)", () => {
  it("returns the same instance on repeated calls (cached at first access)", () => {
    const first = getFanoutConfig();
    const second = getFanoutConfig();
    expect(second).toBe(first);
  });

  it("resetFanoutConfigCacheForTests clears the cache so the next call re-loads", () => {
    const first = getFanoutConfig();
    resetFanoutConfigCacheForTests();
    const second = getFanoutConfig();
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
  });

  it("getObservationCategories / getMedicationRequestStatus read from the cache", () => {
    const cfg = getFanoutConfig();
    expect(getObservationCategories()).toBe(cfg.observationCategories);
    expect(getMedicationRequestStatus()).toBe(cfg.medicationRequestStatus);
  });
});
