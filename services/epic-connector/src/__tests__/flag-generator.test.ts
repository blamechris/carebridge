/**
 * Tests for the CareBridge ClinicalFlag → FHIR Flag generator (#393).
 */
import { describe, it, expect } from "vitest";
import {
  buildFhirFlag,
  flagSeverityCoding,
  mapFlagStatusToFhir,
  CAREBRIDGE_FLAG_SEVERITY_SYSTEM,
  FHIR_FLAG_CATEGORY_SYSTEM,
  RATIONALE_EXTENSION_URL,
  SUGGESTED_ACTION_EXTENSION_URL,
  RULE_ID_EXTENSION_URL,
} from "../outbound/flag-generator.js";

const baseFlag = {
  summary: "Cross-specialty stroke risk: VTE + new neurologic symptoms",
  rationale: "Patient with active VTE prescribed anticoagulant; reports headache",
  suggested_action: "Order STAT non-contrast CT head",
  severity: "critical" as const,
  category: "cross-specialty" as const,
  status: "open" as const,
  rule_id: "ONCO-VTE-NEURO-001",
  created_at: "2026-05-22T10:00:00Z",
  resolved_at: undefined,
  dismissed_at: undefined,
};

describe("buildFhirFlag (#393)", () => {
  it("produces a FHIR R4 Flag with all required spec fields", () => {
    const flag = buildFhirFlag({
      flag: baseFlag,
      epicPatientFhirId: "epic-patient-1",
    });

    expect(flag.resourceType).toBe("Flag");
    expect(flag.status).toBe("active");
    expect(flag.code.text).toBe(baseFlag.summary);
    expect(flag.subject.reference).toBe("Patient/epic-patient-1");
    expect(flag.category[0]?.coding[0]?.system).toBe(FHIR_FLAG_CATEGORY_SYSTEM);
    expect(flag.category[0]?.coding[0]?.code).toBe("clinical");
  });

  it("encodes severity in the code.coding entry", () => {
    const flag = buildFhirFlag({
      flag: baseFlag,
      epicPatientFhirId: "p-1",
    });
    const sev = flag.code.coding[0]!;
    expect(sev.system).toBe(CAREBRIDGE_FLAG_SEVERITY_SYSTEM);
    expect(sev.code).toBe("critical");
    expect(sev.display).toMatch(/Critical/);
  });

  it("carries the category as a secondary coding for richer Epic display", () => {
    const flag = buildFhirFlag({
      flag: baseFlag,
      epicPatientFhirId: "p-1",
    });
    const codings = flag.category[0]?.coding ?? [];
    const cb = codings.find((c) =>
      c.system?.startsWith("https://carebridge.dev"),
    );
    expect(cb?.code).toBe("cross-specialty");
  });

  it("emits rationale + suggested_action + rule_id as FHIR extensions", () => {
    const flag = buildFhirFlag({
      flag: baseFlag,
      epicPatientFhirId: "p-1",
    });
    const ext = flag.extension ?? [];
    expect(ext.find((e) => e.url === RATIONALE_EXTENSION_URL)?.valueString).toBe(
      baseFlag.rationale,
    );
    expect(
      ext.find((e) => e.url === SUGGESTED_ACTION_EXTENSION_URL)?.valueString,
    ).toBe(baseFlag.suggested_action);
    expect(ext.find((e) => e.url === RULE_ID_EXTENSION_URL)?.valueString).toBe(
      baseFlag.rule_id,
    );
  });

  it("omits rule_id extension when the flag is LLM-only (no rule_id)", () => {
    const flag = buildFhirFlag({
      flag: { ...baseFlag, rule_id: undefined },
      epicPatientFhirId: "p-1",
    });
    const ext = flag.extension ?? [];
    expect(ext.find((e) => e.url === RULE_ID_EXTENSION_URL)).toBeUndefined();
  });

  it("sets period.end on resolved flags", () => {
    const flag = buildFhirFlag({
      flag: {
        ...baseFlag,
        status: "resolved",
        resolved_at: "2026-05-22T18:00:00Z",
      },
      epicPatientFhirId: "p-1",
    });
    expect(flag.status).toBe("inactive");
    expect(flag.period?.start).toBe(baseFlag.created_at);
    expect(flag.period?.end).toBe("2026-05-22T18:00:00Z");
  });

  it("sets period.end on dismissed flags", () => {
    const flag = buildFhirFlag({
      flag: {
        ...baseFlag,
        status: "dismissed",
        dismissed_at: "2026-05-22T18:30:00Z",
      },
      epicPatientFhirId: "p-1",
    });
    expect(flag.status).toBe("inactive");
    expect(flag.period?.end).toBe("2026-05-22T18:30:00Z");
  });

  it("propagates the epicFlagId onto the output for PUT payloads", () => {
    const flag = buildFhirFlag({
      flag: baseFlag,
      epicPatientFhirId: "p-1",
      epicFlagId: "epic-flag-abc",
    });
    expect(flag.id).toBe("epic-flag-abc");
  });

  it("acknowledged + escalated map to active (still surfaces in Epic banner)", () => {
    expect(mapFlagStatusToFhir("open")).toBe("active");
    expect(mapFlagStatusToFhir("acknowledged")).toBe("active");
    expect(mapFlagStatusToFhir("escalated")).toBe("active");
    expect(mapFlagStatusToFhir("resolved")).toBe("inactive");
    expect(mapFlagStatusToFhir("dismissed")).toBe("inactive");
  });

  it("flagSeverityCoding includes a clinician-readable display per severity band", () => {
    expect(flagSeverityCoding("critical").display).toMatch(/Critical/);
    expect(flagSeverityCoding("warning").display).toMatch(/review/i);
    expect(flagSeverityCoding("info").display).toBe("Informational");
  });
});
