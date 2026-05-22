import { describe, it, expect } from "vitest";
import { toFhirPatient } from "../generators/patient.js";
import { CAREBRIDGE_IDENTIFIER_BASE } from "../generators/identifiers.js";

type Patient = Parameters<typeof toFhirPatient>[0];

function makePatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: "pat-1",
    name: "Jane Doe",
    date_of_birth: "1980-05-12",
    biological_sex: "female",
    mrn: "MRN-12345",
    ...overrides,
  };
}

describe("toFhirPatient MRN identifier (#969)", () => {
  it("emits MRN under CAREBRIDGE_IDENTIFIER_BASE/mrn", () => {
    const p = toFhirPatient(makePatient());
    const ident = p.identifier?.[0];
    expect(ident).toBeDefined();
    expect(ident?.system).toBe(`${CAREBRIDGE_IDENTIFIER_BASE}/mrn`);
    expect(ident?.value).toBe("MRN-12345");
  });

  it("uses the shared canonical https carebridge.dev namespace", () => {
    const p = toFhirPatient(makePatient());
    expect(p.identifier?.[0]?.system).toMatch(
      /^https:\/\/carebridge\.dev\/fhir\/sid\/mrn$/,
    );
    expect(p.identifier?.[0]?.system).not.toMatch(/carebridge\.health/);
    expect(p.identifier?.[0]?.system).not.toMatch(/^http:/);
  });

  it("preserves the HL7 v2-0203 'MR' type coding alongside the system change", () => {
    const p = toFhirPatient(makePatient());
    const coding = p.identifier?.[0]?.type?.coding?.[0];
    expect(coding?.system).toBe(
      "http://terminology.hl7.org/CodeSystem/v2-0203",
    );
    expect(coding?.code).toBe("MR");
  });

  it("omits identifier entirely when MRN is null", () => {
    const p = toFhirPatient(makePatient({ mrn: null }));
    expect(p.identifier).toBeUndefined();
  });
});
