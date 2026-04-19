import { describe, it, expect } from "vitest";
import { toFhirMedicationRequest } from "../generators/medication-request.js";

type Medication = Parameters<typeof toFhirMedicationRequest>[0];

function makeMed(overrides: Partial<Medication> = {}): Medication {
  return {
    id: "m1",
    patient_id: "p1",
    name: "Amoxicillin",
    brand_name: null,
    dose_amount: 500,
    dose_unit: "mg",
    route: "oral",
    frequency: "TID x 10 days",
    status: "active",
    started_at: "2026-04-10T00:00:00.000Z",
    ended_at: null,
    prescribed_by: null,
    notes: null,
    rxnorm_code: "723",
    ordering_provider_id: "prov1",
    encounter_id: null,
    source_system: "internal",
    created_at: "2026-04-10T00:00:00.000Z",
    updated_at: "2026-04-10T00:00:00.000Z",
    ...overrides,
  } as Medication;
}

describe("toFhirMedicationRequest (#388)", () => {
  it("always emits intent='order' for CareBridge prescriptions", () => {
    const r = toFhirMedicationRequest(makeMed(), "p1");
    expect(r.resourceType).toBe("MedicationRequest");
    expect(r.intent).toBe("order");
  });

  describe("status mapping (MedicationRequest value set)", () => {
    const cases: Array<[string, string]> = [
      ["active", "active"],
      ["held", "on-hold"],
      ["on-hold", "on-hold"],
      ["cancelled", "cancelled"],
      ["canceled", "cancelled"],
      ["completed", "completed"],
      ["discontinued", "stopped"],
      ["stopped", "stopped"],
      ["draft", "draft"],
      ["entered-in-error", "entered-in-error"],
      ["xyz", "unknown"],
      // Case-insensitive — prior version mapped any non-lowercase value
      // to "unknown", hiding legitimate active prescriptions in the FHIR
      // export when the DB carried a mixed-case status.
      ["ACTIVE", "active"],
      ["On-Hold", "on-hold"],
      ["COMPLETED", "completed"],
    ];
    for (const [input, expected] of cases) {
      it(`maps status '${input}' → '${expected}'`, () => {
        expect(toFhirMedicationRequest(makeMed({ status: input }), "p1").status).toBe(
          expected,
        );
      });
    }
  });

  it("emits RxNorm coding when rxnorm_code is present", () => {
    const r = toFhirMedicationRequest(
      makeMed({ rxnorm_code: "723", name: "Amoxicillin" }),
      "p1",
    );
    const coding = r.medicationCodeableConcept?.coding?.[0];
    expect(coding?.system).toBe("http://www.nlm.nih.gov/research/umls/rxnorm");
    expect(coding?.code).toBe("723");
    expect(coding?.display).toBe("Amoxicillin");
  });

  it("falls back to 'unknown' code when rxnorm_code absent", () => {
    const r = toFhirMedicationRequest(
      makeMed({ rxnorm_code: null }),
      "p1",
    );
    expect(r.medicationCodeableConcept?.coding?.[0]?.code).toBe("unknown");
  });

  it("includes brand_name parenthetically in medicationCodeableConcept.text", () => {
    const r = toFhirMedicationRequest(
      makeMed({ name: "Atorvastatin", brand_name: "Lipitor" }),
      "p1",
    );
    expect(r.medicationCodeableConcept?.text).toBe("Atorvastatin (Lipitor)");
  });

  it("sets authoredOn to started_at", () => {
    const r = toFhirMedicationRequest(
      makeMed({ started_at: "2026-04-10T00:00:00.000Z" }),
      "p1",
    );
    expect(r.authoredOn).toBe("2026-04-10T00:00:00.000Z");
  });

  it("requester prefers ordering_provider_id over prescribed_by", () => {
    const r = toFhirMedicationRequest(
      makeMed({ ordering_provider_id: "op1", prescribed_by: "pb1" }),
      "p1",
    );
    expect(r.requester?.reference).toBe("Practitioner/op1");
  });

  it("requester falls back to prescribed_by when ordering_provider_id is null", () => {
    const r = toFhirMedicationRequest(
      makeMed({ ordering_provider_id: null, prescribed_by: "pb1" }),
      "p1",
    );
    expect(r.requester?.reference).toBe("Practitioner/pb1");
  });

  it("emits dosageInstruction with route SNOMED + dose + frequency", () => {
    const r = toFhirMedicationRequest(
      makeMed({
        dose_amount: 500,
        dose_unit: "mg",
        route: "oral",
        frequency: "TID x 10 days",
      }),
      "p1",
    );
    const d = r.dosageInstruction?.[0];
    expect(d?.doseAndRate?.[0]?.doseQuantity?.value).toBe(500);
    expect(d?.doseAndRate?.[0]?.doseQuantity?.unit).toBe("mg");
    expect(d?.route?.coding?.[0]?.system).toBe("http://snomed.info/sct");
    expect(d?.route?.coding?.[0]?.code).toBe("26643006"); // Oral route
    expect(d?.timing?.code?.text).toBe("TID x 10 days");
    expect(d?.text).toBe("500 mg oral TID x 10 days");
  });

  it("omits dosageInstruction entirely when no dosage fields are set", () => {
    const r = toFhirMedicationRequest(
      makeMed({
        dose_amount: null,
        dose_unit: null,
        route: null,
        frequency: null,
      }),
      "p1",
    );
    expect(r.dosageInstruction).toBeUndefined();
  });
});
