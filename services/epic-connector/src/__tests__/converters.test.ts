/**
 * Unit tests for Epic FHIR → CareBridge row converters (#390).
 *
 * Uses realistic FHIR R4 payload shapes (Epic-style identifier systems,
 * SNOMED route codes, LOINC observation codes) so the tests catch
 * Epic-specific quirks without requiring sandbox access.
 */
import { describe, it, expect } from "vitest";
import {
  EPIC_SOURCE_SYSTEM_TAG,
  epicPatientToRow,
  epicMedicationRequestToRow,
  epicMedicationStatementToRow,
  epicObservationToRow,
  epicConditionToRow,
  epicAllergyToRow,
} from "../converters.js";
import type { FhirResource } from "../fhir-types.js";

describe("Epic FHIR → CareBridge converters (#390)", () => {
  describe("epicPatientToRow", () => {
    it("maps a typical Epic Patient resource and tags source_system=epic", () => {
      const resource: FhirResource = {
        resourceType: "Patient",
        id: "epic-patient-1",
        active: true,
        identifier: [
          {
            use: "usual",
            system: "urn:oid:1.2.840.114350.1.13.0.1.7.5.737384.0",
            value: "E1234",
          },
          {
            use: "official",
            type: {
              coding: [
                {
                  system: "http://terminology.hl7.org/CodeSystem/v2-0203",
                  code: "MR",
                  display: "Medical Record Number",
                },
              ],
            },
            value: "MRN-987",
          },
        ],
        name: [{ use: "official", family: "Smith", given: ["John", "Q"] }],
        gender: "male",
        birthDate: "1980-01-15",
      };

      const row = epicPatientToRow(resource);
      expect(row).not.toBeNull();
      expect(row?.source_system).toBe(EPIC_SOURCE_SYSTEM_TAG);
      expect(row?.mrn).toBe("MRN-987");
    });

    it("returns null for retired patient (active=false)", () => {
      const row = epicPatientToRow({
        resourceType: "Patient",
        id: "p-1",
        active: false,
        name: [{ family: "Smith", given: ["John"] }],
      });
      expect(row).toBeNull();
    });
  });

  describe("epicMedicationRequestToRow", () => {
    it("maps a MedicationRequest with dosing and tags source_system=epic", () => {
      const resource: FhirResource = {
        resourceType: "MedicationRequest",
        id: "med-req-1",
        status: "active",
        intent: "order",
        medicationCodeableConcept: {
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "1049502",
              display: "acetaminophen 325 MG Oral Tablet",
            },
          ],
        },
        subject: { reference: "Patient/p-1" },
        dosageInstruction: [
          {
            route: {
              coding: [
                {
                  system: "http://snomed.info/sct",
                  code: "26643006",
                  display: "Oral route",
                },
              ],
            },
            doseAndRate: [
              { doseQuantity: { value: 650, unit: "mg" } },
            ],
          },
        ],
      };
      const row = epicMedicationRequestToRow(resource, "patient-uuid-1");
      expect(row).not.toBeNull();
      expect(row?.source_system).toBe(EPIC_SOURCE_SYSTEM_TAG);
      expect(row?.patient_id).toBe("patient-uuid-1");
      expect(row?.route).toBe("oral");
    });

    it("returns null for entered-in-error MedicationRequest", () => {
      const row = epicMedicationRequestToRow(
        {
          resourceType: "MedicationRequest",
          status: "entered-in-error",
          medicationCodeableConcept: { text: "tylenol" },
        },
        "p-1",
      );
      expect(row).toBeNull();
    });
  });

  describe("epicMedicationStatementToRow", () => {
    it("maps a MedicationStatement (prior outpatient med list)", () => {
      const resource: FhirResource = {
        resourceType: "MedicationStatement",
        status: "active",
        medicationCodeableConcept: { text: "lisinopril 10 mg" },
        subject: { reference: "Patient/p-1" },
      };
      const row = epicMedicationStatementToRow(resource, "patient-uuid-1");
      expect(row).not.toBeNull();
      expect(row?.source_system).toBe(EPIC_SOURCE_SYSTEM_TAG);
      expect(row?.patient_id).toBe("patient-uuid-1");
    });
  });

  describe("epicObservationToRow", () => {
    it("routes vital-signs Observations to a vital row", () => {
      const resource: FhirResource = {
        resourceType: "Observation",
        status: "final",
        category: [
          {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/observation-category",
                code: "vital-signs",
              },
            ],
          },
        ],
        code: {
          coding: [
            { system: "http://loinc.org", code: "8867-4", display: "Heart rate" },
          ],
        },
        effectiveDateTime: "2026-05-20T10:30:00Z",
        valueQuantity: { value: 72, unit: "beats/min" },
      };
      const result = epicObservationToRow(resource, "patient-uuid-1");
      expect(result.kind).toBe("vital");
      if (result.kind !== "vital") return;
      expect(result.row.source_system).toBe(EPIC_SOURCE_SYSTEM_TAG);
      expect(result.row.patient_id).toBe("patient-uuid-1");
      expect(result.row.type).toBe("heart_rate");
    });

    it("routes laboratory Observations to a lab row with patient_id + source_system", () => {
      const resource: FhirResource = {
        resourceType: "Observation",
        status: "final",
        category: [
          {
            coding: [
              {
                system: "http://terminology.hl7.org/CodeSystem/observation-category",
                code: "laboratory",
              },
            ],
          },
        ],
        code: {
          coding: [
            { system: "http://loinc.org", code: "718-7", display: "Hemoglobin" },
          ],
          text: "Hemoglobin",
        },
        effectiveDateTime: "2026-05-20T08:00:00Z",
        valueQuantity: { value: 13.5, unit: "g/dL" },
      };
      const result = epicObservationToRow(resource, "patient-uuid-1");
      expect(result.kind).toBe("lab");
      if (result.kind !== "lab") return;
      expect(result.row.patient_id).toBe("patient-uuid-1");
      expect(result.row.source_system).toBe(EPIC_SOURCE_SYSTEM_TAG);
      expect(result.row.test_code).toBe("718-7");
    });

    it("returns unmapped for Observations with no category", () => {
      const result = epicObservationToRow(
        {
          resourceType: "Observation",
          status: "final",
          code: { coding: [{ system: "http://loinc.org", code: "9999-9" }] },
        },
        "p-1",
      );
      expect(result.kind).toBe("unmapped");
    });
  });

  describe("epicConditionToRow", () => {
    it("maps an active Condition and adds source_system=epic", () => {
      const resource: FhirResource = {
        resourceType: "Condition",
        clinicalStatus: {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/condition-clinical",
              code: "active",
            },
          ],
        },
        code: {
          coding: [
            {
              system: "http://hl7.org/fhir/sid/icd-10-cm",
              code: "I82.401",
              display: "Acute embolism and thrombosis of unspecified deep veins of right lower extremity",
            },
          ],
          text: "DVT, right lower extremity",
        },
        subject: { reference: "Patient/p-1" },
        onsetDateTime: "2026-05-15",
      };
      const row = epicConditionToRow(resource, "patient-uuid-1");
      expect(row).not.toBeNull();
      expect(row?.source_system).toBe(EPIC_SOURCE_SYSTEM_TAG);
      expect(row?.status).toBe("active");
      expect(row?.icd10_code).toBe("I82.401");
    });
  });

  describe("epicAllergyToRow", () => {
    it("maps an active AllergyIntolerance and tags source_system=epic", () => {
      const resource: FhirResource = {
        resourceType: "AllergyIntolerance",
        clinicalStatus: {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
              code: "active",
            },
          ],
        },
        verificationStatus: {
          coding: [
            {
              system:
                "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
              code: "confirmed",
            },
          ],
        },
        code: {
          coding: [
            {
              system: "http://www.nlm.nih.gov/research/umls/rxnorm",
              code: "7980",
              display: "Penicillin G",
            },
          ],
          text: "Penicillin",
        },
        patient: { reference: "Patient/p-1" },
        criticality: "high",
      };
      const row = epicAllergyToRow(resource, "patient-uuid-1");
      expect(row).not.toBeNull();
      expect(row?.source_system).toBe(EPIC_SOURCE_SYSTEM_TAG);
      expect(row?.patient_id).toBe("patient-uuid-1");
    });
  });

  it("EPIC_SOURCE_SYSTEM_TAG is the string 'epic' (lock-in)", () => {
    // The tag is part of the public contract — downstream queries
    // filter by it. Don't accidentally rename it without coordinating
    // with the sync worker (#391).
    expect(EPIC_SOURCE_SYSTEM_TAG).toBe("epic");
  });
});
