/**
 * #1251 — fhir-gateway: operator-visible log when CPT coding is suppressed
 * by the AMA licensing gate.
 *
 * When `procedure.cpt_code` is present but `FHIR_CPT_EMISSION_ENABLED` is
 * not the literal string "true", the gateway silently falls back to a
 * free-text Procedure.code. That silent drop is the conservative default
 * (#939), but without a log line operators can't tell apart "no rows have
 * cpt_code" from "env var is misconfigured ('True' / '1' / 'yes' instead
 * of 'true')". This test pins the one-shot operator breadcrumb in place.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const infoSpy = vi.fn();

vi.mock("@carebridge/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: infoSpy,
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const {
  toFhirProcedure,
  __resetCptSuppressionLogForTests,
} = await import("../generators/procedure.js");

type Procedure = Parameters<typeof toFhirProcedure>[0];

function makeProcedure(overrides: Partial<Procedure> = {}): Procedure {
  return {
    id: "p1",
    patient_id: "pat1",
    name: "Appendectomy",
    cpt_code: "44970",
    icd10_codes: ["K35.80"],
    status: "completed",
    performed_at: "2026-04-10T14:00:00.000Z",
    performed_by: "surg1",
    provider_id: null,
    encounter_id: null,
    notes: null,
    source_system: "internal",
    created_at: "2026-04-10T14:00:00.000Z",
    ...overrides,
  } as Procedure;
}

describe("CPT suppression operator log (#1251)", () => {
  let previous: string | undefined;
  beforeEach(() => {
    infoSpy.mockClear();
    __resetCptSuppressionLogForTests();
    previous = process.env.FHIR_CPT_EMISSION_ENABLED;
    delete process.env.FHIR_CPT_EMISSION_ENABLED;
  });
  afterEach(() => {
    if (previous === undefined) {
      delete process.env.FHIR_CPT_EMISSION_ENABLED;
    } else {
      process.env.FHIR_CPT_EMISSION_ENABLED = previous;
    }
  });

  it("emits logger.info breadcrumb when gate suppresses a cpt_code", () => {
    toFhirProcedure(
      makeProcedure({ cpt_code: "44970", name: "Laparoscopic appendectomy" }),
      "pat1",
    );

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [msg, meta] = infoSpy.mock.calls[0]!;
    expect(msg).toBe("CPT coding suppressed by licensing gate");
    expect(meta).toMatchObject({ flag: "FHIR_CPT_EMISSION_ENABLED" });
  });

  it("does NOT include the suppressed cpt_code value in the log meta", () => {
    toFhirProcedure(
      makeProcedure({ cpt_code: "44970", name: "Laparoscopic appendectomy" }),
      "pat1",
    );

    // The log stream may have a different licensing posture than the
    // FHIR bundle itself — never leak the code through logs (#1251 AC).
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(infoSpy.mock.calls);
    expect(serialized).not.toContain("44970");
  });

  it("logs at most once per process across many suppressed rows", () => {
    for (let i = 0; i < 5; i++) {
      toFhirProcedure(
        makeProcedure({
          id: `p${i}`,
          cpt_code: "44970",
          name: "Laparoscopic appendectomy",
        }),
        "pat1",
      );
    }

    expect(infoSpy).toHaveBeenCalledTimes(1);
  });

  it("does NOT log when the gate is open (flag = 'true')", () => {
    process.env.FHIR_CPT_EMISSION_ENABLED = "true";

    toFhirProcedure(
      makeProcedure({ cpt_code: "44970", name: "Laparoscopic appendectomy" }),
      "pat1",
    );

    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("does NOT log when there is no cpt_code to suppress", () => {
    // The breadcrumb is "we silently dropped a code you might be looking
    // for" — if no code was present, there's nothing to communicate.
    toFhirProcedure(
      makeProcedure({ cpt_code: null, name: "Wound dressing change" }),
      "pat1",
    );

    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("logs once when flag is a non-'true' truthy string ('1', 'yes', 'True')", () => {
    // Mirrors the #1241 misconfig case the issue explicitly calls out.
    process.env.FHIR_CPT_EMISSION_ENABLED = "True";

    toFhirProcedure(
      makeProcedure({ cpt_code: "44970", name: "Laparoscopic appendectomy" }),
      "pat1",
    );

    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoSpy.mock.calls[0]![0]).toBe(
      "CPT coding suppressed by licensing gate",
    );
  });
});
