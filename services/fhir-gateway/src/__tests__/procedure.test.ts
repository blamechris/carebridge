import { describe, it, expect } from "vitest";
import { toFhirProcedure } from "../generators/procedure.js";

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

describe("toFhirProcedure (#387)", () => {
  describe("status mapping", () => {
    const cases: Array<[string, string]> = [
      ["scheduled", "preparation"],
      ["preparation", "preparation"],
      ["in-progress", "in-progress"],
      ["in_progress", "in-progress"],
      ["completed", "completed"],
      ["done", "completed"],
      ["cancelled", "stopped"],
      ["canceled", "stopped"],
      ["stopped", "stopped"],
      ["on-hold", "on-hold"],
      ["not-done", "not-done"],
      ["entered-in-error", "entered-in-error"],
      ["xyz", "unknown"],
    ];
    for (const [input, expected] of cases) {
      it(`maps status '${input}' → '${expected}'`, () => {
        const proc = toFhirProcedure(makeProcedure({ status: input }), "pat1");
        expect(proc.status).toBe(expected);
      });
    }
  });

  describe("code / CPT coding", () => {
    it("emits CPT coding when cpt_code is present", () => {
      const proc = toFhirProcedure(
        makeProcedure({ cpt_code: "44970", name: "Laparoscopic appendectomy" }),
        "pat1",
      );
      const coding = proc.code?.coding?.[0];
      expect(coding?.system).toBe("http://www.ama-assn.org/go/cpt");
      expect(coding?.code).toBe("44970");
      expect(coding?.display).toBe("Laparoscopic appendectomy");
      expect(proc.code?.text).toBe("Laparoscopic appendectomy");
    });

    it("falls back to text-only code when cpt_code is null but name is set", () => {
      const proc = toFhirProcedure(
        makeProcedure({ cpt_code: null, name: "Wound dressing change" }),
        "pat1",
      );
      expect(proc.code?.coding).toBeUndefined();
      expect(proc.code?.text).toBe("Wound dressing change");
    });
  });

  describe("reasonCode (ICD-10)", () => {
    it("maps icd10_codes[] to reasonCode array", () => {
      const proc = toFhirProcedure(
        makeProcedure({ icd10_codes: ["K35.80", "R10.9"] }),
        "pat1",
      );
      expect(proc.reasonCode).toHaveLength(2);
      expect(proc.reasonCode![0]?.coding?.[0]?.system).toBe(
        "http://hl7.org/fhir/sid/icd-10-cm",
      );
      expect(proc.reasonCode![0]?.coding?.[0]?.code).toBe("K35.80");
      expect(proc.reasonCode![1]?.coding?.[0]?.code).toBe("R10.9");
    });

    it("omits reasonCode when icd10_codes is empty", () => {
      const proc = toFhirProcedure(
        makeProcedure({ icd10_codes: [] }),
        "pat1",
      );
      expect(proc.reasonCode).toBeUndefined();
    });

    it("omits reasonCode when icd10_codes is null", () => {
      const proc = toFhirProcedure(
        makeProcedure({ icd10_codes: null }),
        "pat1",
      );
      expect(proc.reasonCode).toBeUndefined();
    });
  });

  describe("subject / performer / performedDateTime", () => {
    it("attaches a Patient reference", () => {
      const proc = toFhirProcedure(makeProcedure(), "pat1");
      expect(proc.subject.reference).toBe("Patient/pat1");
    });

    it("emits performer as Practitioner when performed_by set", () => {
      const proc = toFhirProcedure(
        makeProcedure({ performed_by: "surg99" }),
        "pat1",
      );
      expect(proc.performer?.[0]?.actor?.reference).toBe("Practitioner/surg99");
    });

    it("omits performer when performed_by is null", () => {
      const proc = toFhirProcedure(
        makeProcedure({ performed_by: null }),
        "pat1",
      );
      expect(proc.performer).toBeUndefined();
    });

    it("emits performedDateTime when performed_at set", () => {
      const proc = toFhirProcedure(
        makeProcedure({ performed_at: "2026-04-10T14:00:00.000Z" }),
        "pat1",
      );
      expect(proc.performedDateTime).toBe("2026-04-10T14:00:00.000Z");
    });

    it("omits performedDateTime when performed_at is null (scheduled procedure)", () => {
      const proc = toFhirProcedure(
        makeProcedure({
          performed_at: null,
          status: "scheduled",
        }),
        "pat1",
      );
      expect(proc.performedDateTime).toBeUndefined();
      expect(proc.status).toBe("preparation");
    });
  });
});
