/**
 * Unit tests for Epic sync fan-out config (#1098, #1110, #1111, #1112,
 * #1113).
 *
 * The fan-out config controls which Observation categories and which
 * MedicationRequest status the Epic sync worker fans out over.
 * Defaults match CareBridge's MVP scope; env overrides let an operator
 * widen/narrow the set without code changes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
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
  parseFanoutConfig,
  getFanoutConfig,
  resetFanoutConfigCacheForTests,
  getObservationCategories,
  getMedicationRequestStatus,
  getMedicationRequestStatuses,
  DEFAULT_OBSERVATION_CATEGORIES,
  DEFAULT_MEDICATION_REQUEST_STATUS,
  DEFAULT_MEDICATION_REQUEST_STATUSES,
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

describe("loadFanoutConfig — MedicationRequest status (#1098, #1110, #1111, #1114)", () => {
  it("returns the MVP default ['active'] when env is unset", () => {
    expect(loadFanoutConfig({}).medicationRequestStatuses).toEqual(["active"]);
  });

  it("DEFAULT_MEDICATION_REQUEST_STATUSES matches the documented MVP set", () => {
    expect(DEFAULT_MEDICATION_REQUEST_STATUSES).toEqual(["active"]);
  });

  it("DEFAULT_MEDICATION_REQUEST_STATUS (singular) is back-compat alias for the first default", () => {
    // Back-compat: singular constant is retained so downstream consumers
    // pinned to the pre-#1114 export keep compiling.
    expect(DEFAULT_MEDICATION_REQUEST_STATUS).toBe("active");
  });

  it("uses the EPIC_MEDICATION_REQUEST_STATUS override as a single-value list when set to a valid code", () => {
    expect(
      loadFanoutConfig({ EPIC_MEDICATION_REQUEST_STATUS: "on-hold" })
        .medicationRequestStatuses,
    ).toEqual(["on-hold"]);
  });

  it("parses a comma-separated multi-status override (#1114)", () => {
    expect(
      loadFanoutConfig({
        EPIC_MEDICATION_REQUEST_STATUS: "active,on-hold,completed",
      }).medicationRequestStatuses,
    ).toEqual(["active", "on-hold", "completed"]);
  });

  it("trims whitespace around the override (single value)", () => {
    expect(
      loadFanoutConfig({
        EPIC_MEDICATION_REQUEST_STATUS: "  completed  ",
      }).medicationRequestStatuses,
    ).toEqual(["completed"]);
  });

  it("trims whitespace around comma-separated entries (#1114)", () => {
    expect(
      loadFanoutConfig({
        EPIC_MEDICATION_REQUEST_STATUS: " active , on-hold , completed ",
      }).medicationRequestStatuses,
    ).toEqual(["active", "on-hold", "completed"]);
  });

  it("drops empty segments (trailing comma, double comma) (#1114)", () => {
    expect(
      loadFanoutConfig({
        EPIC_MEDICATION_REQUEST_STATUS: "active,,on-hold,",
      }).medicationRequestStatuses,
    ).toEqual(["active", "on-hold"]);
  });

  it("deduplicates repeated statuses (#1114)", () => {
    expect(
      loadFanoutConfig({
        EPIC_MEDICATION_REQUEST_STATUS: "active,active,on-hold",
      }).medicationRequestStatuses,
    ).toEqual(["active", "on-hold"]);
  });

  it("warns and falls back when env is the empty string", () => {
    const cfg = loadFanoutConfig({ EPIC_MEDICATION_REQUEST_STATUS: "" });
    expect(cfg.medicationRequestStatuses).toEqual(["active"]);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg] = warnSpy.mock.calls[0]!;
    expect(msg).toMatch(/EPIC_MEDICATION_REQUEST_STATUS/);
  });

  it("warns and falls back when env is only whitespace/commas", () => {
    const cfg = loadFanoutConfig({ EPIC_MEDICATION_REQUEST_STATUS: "   ,  ,  " });
    expect(cfg.medicationRequestStatuses).toEqual(["active"]);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("warns and falls back when env is an unknown status code", () => {
    const cfg = loadFanoutConfig({
      EPIC_MEDICATION_REQUEST_STATUS: "in-progress",
    });
    expect(cfg.medicationRequestStatuses).toEqual(["active"]);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, meta] = warnSpy.mock.calls[0]!;
    expect(msg).toMatch(/not a known FHIR medication-request-status/);
    expect(meta).toMatchObject({
      invalidCodes: ["in-progress"],
      fallback: ["active"],
    });
  });

  it("drops unknown codes from a partial misconfig but keeps the valid ones (#1114)", () => {
    const cfg = loadFanoutConfig({
      EPIC_MEDICATION_REQUEST_STATUS: "active,in-progress,on-hold,foo",
    });
    expect(cfg.medicationRequestStatuses).toEqual(["active", "on-hold"]);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg, meta] = warnSpy.mock.calls[0]!;
    expect(msg).toMatch(/unknown FHIR medication-request-status/);
    expect(meta).toMatchObject({
      invalidCodes: ["in-progress", "foo"],
      kept: ["active", "on-hold"],
    });
  });

  it("falls back to defaults when ALL codes are unknown (#1114)", () => {
    const cfg = loadFanoutConfig({
      EPIC_MEDICATION_REQUEST_STATUS: "foo,bar,baz",
    });
    expect(cfg.medicationRequestStatuses).toEqual(["active"]);
    expect(warnSpy).toHaveBeenCalledOnce();
    const [, meta] = warnSpy.mock.calls[0]!;
    expect(meta).toMatchObject({ invalidCodes: ["foo", "bar", "baz"] });
  });

  it("accepts all 8 valid FHIR medication-request-status codes individually", () => {
    for (const status of VALID_MEDICATION_REQUEST_STATUSES) {
      warnSpy.mockClear();
      const cfg = loadFanoutConfig({
        EPIC_MEDICATION_REQUEST_STATUS: status,
      });
      expect(cfg.medicationRequestStatuses).toEqual([status]);
      expect(warnSpy).not.toHaveBeenCalled();
    }
  });

  it("does NOT warn when env is unset", () => {
    loadFanoutConfig({});
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe("parseFanoutConfig — pure-eval mode (#1116)", () => {
  it("returns the same config as loadFanoutConfig for any given env", () => {
    const env = {
      EPIC_OBSERVATION_CATEGORIES: "vital-signs,laboratory,exam",
      EPIC_MEDICATION_REQUEST_STATUS: "completed",
    };
    const loaded = loadFanoutConfig(env);
    const { config } = parseFanoutConfig(env);
    expect(config).toEqual(loaded);
  });

  it("does NOT emit any warnings via the module logger — admin/diagnostics tooling can preview an env safely", () => {
    parseFanoutConfig({
      EPIC_OBSERVATION_CATEGORIES: "foo,bar",
      EPIC_MEDICATION_REQUEST_STATUS: "in-progress",
    });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("returns warnings as a structured array so admin tooling can render them without scraping log output", () => {
    const { warnings } = parseFanoutConfig({
      EPIC_OBSERVATION_CATEGORIES: "vital-signs,foo",
      EPIC_MEDICATION_REQUEST_STATUS: "in-progress",
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]!.msg).toMatch(/unknown FHIR observation-category/);
    expect(warnings[0]!.meta).toMatchObject({
      invalidCodes: ["foo"],
      kept: ["vital-signs"],
    });
    expect(warnings[1]!.msg).toMatch(/not a known FHIR medication-request-status/);
    expect(warnings[1]!.meta).toMatchObject({
      invalidCodes: ["in-progress"],
      fallback: ["active"],
    });
  });

  it("returns an empty warnings array when env is unset (no operator intent to override)", () => {
    const { warnings } = parseFanoutConfig({});
    expect(warnings).toEqual([]);
  });

  it("loadFanoutConfig is a thin wrapper — it forwards parseFanoutConfig's warnings to the logger", () => {
    loadFanoutConfig({
      EPIC_OBSERVATION_CATEGORIES: "foo,bar",
    });
    expect(warnSpy).toHaveBeenCalledOnce();
    const [msg] = warnSpy.mock.calls[0]!;
    expect(msg).toMatch(/EPIC_OBSERVATION_CATEGORIES/);
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

  it("getObservationCategories / getMedicationRequestStatuses read from the cache", () => {
    const cfg = getFanoutConfig();
    expect(getObservationCategories()).toBe(cfg.observationCategories);
    expect(getMedicationRequestStatuses()).toBe(cfg.medicationRequestStatuses);
  });

  it("getMedicationRequestStatus (singular, back-compat) returns the first element of the plural list", () => {
    // Singular helper is retained as a thin wrapper for downstream
    // consumers pinned to the pre-#1114 API. New code should call the
    // plural helper.
    const cfg = getFanoutConfig();
    expect(getMedicationRequestStatus()).toBe(cfg.medicationRequestStatuses[0]);
  });

  it("the cached config is deeply frozen — mutation attempts throw", () => {
    const cfg = getFanoutConfig();
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.observationCategories)).toBe(true);
    expect(Object.isFrozen(cfg.medicationRequestStatuses)).toBe(true);
    expect(() => {
      (cfg.observationCategories as string[]).push("foo");
    }).toThrow(TypeError);
    expect(() => {
      (cfg.medicationRequestStatuses as string[]).push("stopped");
    }).toThrow(TypeError);
  });
});

describe("FanoutConfig.medicationRequestStatus — deprecated singular field (#1147)", () => {
  // PR #1140 removed the singular `medicationRequestStatus` field from
  // the `FanoutConfig` interface in favour of the plural array. The
  // interface is re-exported from the package root, so any external
  // consumer reading `cfg.medicationRequestStatus` would break at
  // compile time. #1147 restores it as a deprecated alias for
  // `medicationRequestStatuses[0]`.

  it("loadFanoutConfig exposes the singular field equal to medicationRequestStatuses[0] (default)", () => {
    const cfg = loadFanoutConfig({});
    expect(cfg.medicationRequestStatus).toBe(cfg.medicationRequestStatuses[0]);
    expect(cfg.medicationRequestStatus).toBe(DEFAULT_MEDICATION_REQUEST_STATUS);
  });

  it("singular field reflects the first element of a multi-status env override", () => {
    const cfg = loadFanoutConfig({
      EPIC_MEDICATION_REQUEST_STATUS: "draft,active",
    });
    expect(cfg.medicationRequestStatuses).toEqual(["draft", "active"]);
    expect(cfg.medicationRequestStatus).toBe("draft");
  });

  it("singular field reflects a single-value env override", () => {
    const cfg = loadFanoutConfig({
      EPIC_MEDICATION_REQUEST_STATUS: "completed",
    });
    expect(cfg.medicationRequestStatus).toBe("completed");
    expect(cfg.medicationRequestStatus).toBe(cfg.medicationRequestStatuses[0]);
  });

  it("singular field falls back to DEFAULT_MEDICATION_REQUEST_STATUS when env is empty/invalid", () => {
    // Empty/all-invalid env triggers the fall-back path which seeds the
    // array with the default, so the singular alias should reflect that
    // default rather than being undefined.
    const cfgEmpty = loadFanoutConfig({ EPIC_MEDICATION_REQUEST_STATUS: "" });
    expect(cfgEmpty.medicationRequestStatus).toBe(
      DEFAULT_MEDICATION_REQUEST_STATUS,
    );
    warnSpy.mockClear();
    const cfgInvalid = loadFanoutConfig({
      EPIC_MEDICATION_REQUEST_STATUS: "foo,bar",
    });
    expect(cfgInvalid.medicationRequestStatus).toBe(
      DEFAULT_MEDICATION_REQUEST_STATUS,
    );
  });

  it("parseFanoutConfig exposes the singular field on the returned config", () => {
    const { config } = parseFanoutConfig({
      EPIC_MEDICATION_REQUEST_STATUS: "on-hold,active",
    });
    expect(config.medicationRequestStatus).toBe("on-hold");
    expect(config.medicationRequestStatus).toBe(config.medicationRequestStatuses[0]);
  });

  it("getFanoutConfig (cached) exposes the singular field equal to the plural first element", () => {
    const cfg = getFanoutConfig();
    expect(cfg.medicationRequestStatus).toBe(cfg.medicationRequestStatuses[0]);
  });

  it("source declares @deprecated JSDoc on the singular field so consumers see the upgrade hint", () => {
    // Read the source file so we can assert the interface field carries
    // a @deprecated tag — back-compat shims that ship without a
    // deprecation marker tend to become permanent.
    const here = dirname(fileURLToPath(import.meta.url));
    const sourcePath = resolve(here, "..", "sync", "fanout-config.ts");
    // Normalise CRLF→LF so the regex below isn't sensitive to whether
    // the checkout used `core.autocrlf=true` on Windows (#1153 review).
    const src = readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
    // Find the FanoutConfig interface body. The opener match is
    // whitespace-tolerant so a future `prettier`/`tsc` reflow that
    // adds/removes spaces around the brace doesn't break the regex.
    const ifaceMatch = src.match(
      /export\s+interface\s+FanoutConfig\s*\{([\s\S]*?)\n\}/,
    );
    expect(ifaceMatch, "FanoutConfig interface not found").not.toBeNull();
    const body = ifaceMatch![1]!;
    // The singular field must be declared inside the interface body.
    expect(body).toMatch(/medicationRequestStatus\s*:/);
    // And it must carry a @deprecated tag in a JSDoc immediately above
    // its declaration.
    expect(body).toMatch(
      /@deprecated[\s\S]*?medicationRequestStatus\s*:\s*string/,
    );
  });
});
