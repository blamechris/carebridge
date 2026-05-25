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
  epicEncounterToRow,
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

  describe("epicEncounterToRow", () => {
    it("maps a minimal Encounter (status + subject + period) and tags source_system=epic", () => {
      const resource: FhirResource = {
        resourceType: "Encounter",
        id: "epic-enc-1",
        status: "finished",
        class: {
          system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
          code: "AMB",
          display: "ambulatory",
        },
        subject: { reference: "Patient/p-1" },
        period: {
          start: "2026-05-20T09:00:00Z",
          end: "2026-05-20T09:45:00Z",
        },
      };
      const row = epicEncounterToRow(resource, "patient-uuid-1");
      expect(row).not.toBeNull();
      expect(row?.source_system).toBe(EPIC_SOURCE_SYSTEM_TAG);
      expect(row?.patient_id).toBe("patient-uuid-1");
      expect(row?.status).toBe("finished");
      expect(row?.encounter_type).toBe("AMB");
      expect(row?.start_time).toBe("2026-05-20T09:00:00Z");
      expect(row?.end_time).toBe("2026-05-20T09:45:00Z");
    });

    it("maps a full Encounter with all optional fields (epic_encounter_id from identifier, reason text, location display)", () => {
      const resource: FhirResource = {
        resourceType: "Encounter",
        id: "epic-enc-2",
        identifier: [
          {
            use: "official",
            // Epic Contact Serial Number (CSN) — the canonical Encounter identifier.
            system: "urn:oid:1.2.840.114350.1.13.0.1.7.3.698084.8",
            value: "CSN-1234567",
          },
          {
            use: "secondary",
            system: "http://other.example/encounter",
            value: "OTHER-99",
          },
        ],
        status: "in-progress",
        class: {
          system: "http://terminology.hl7.org/CodeSystem/v3-ActCode",
          code: "EMER",
          display: "emergency",
        },
        subject: { reference: "Patient/p-1" },
        period: {
          start: "2026-05-20T14:00:00Z",
          end: "2026-05-20T18:30:00Z",
        },
        reasonCode: [
          {
            coding: [
              {
                system: "http://snomed.info/sct",
                code: "271807003",
                display: "Eruption of skin",
              },
            ],
            text: "Rash",
          },
        ],
        participant: [
          {
            individual: { reference: "Practitioner/practitioner-1" },
          },
        ],
        location: [
          {
            location: {
              reference: "Location/loc-1",
              display: "ER Bay 7",
            },
          },
        ],
      };
      const row = epicEncounterToRow(resource, "patient-uuid-1");
      expect(row).not.toBeNull();
      expect(row?.source_system).toBe(EPIC_SOURCE_SYSTEM_TAG);
      expect(row?.patient_id).toBe("patient-uuid-1");
      expect(row?.status).toBe("in-progress");
      expect(row?.encounter_type).toBe("EMER");
      expect(row?.start_time).toBe("2026-05-20T14:00:00Z");
      expect(row?.end_time).toBe("2026-05-20T18:30:00Z");
      // The Epic CSN identifier flows through as the epic_encounter_id surface
      // — fed into the fhir_resources mapping row by the persistence layer.
      expect(row?.epic_encounter_id).toBe("CSN-1234567");
      // reason text takes precedence over the coding[].display.
      expect(row?.reason).toBe("Rash");
      // location[0].location.display surfaces as the row's `location`.
      expect(row?.location).toBe("ER Bay 7");
    });

    it("returns null when subject is missing (cannot link to a patient row)", () => {
      const row = epicEncounterToRow(
        {
          resourceType: "Encounter",
          id: "enc-no-subject",
          status: "finished",
          class: { code: "AMB" },
          period: { start: "2026-05-20T09:00:00Z" },
        },
        "patient-uuid-1",
      );
      expect(row).toBeNull();
    });

    it("falls through to 'unknown' for non-FHIR statuses (preserves codeset safety)", () => {
      const row = epicEncounterToRow(
        {
          resourceType: "Encounter",
          id: "enc-bad-status",
          status: "totally-made-up-status",
          class: { code: "AMB" },
          subject: { reference: "Patient/p-1" },
          period: { start: "2026-05-20T09:00:00Z" },
        },
        "patient-uuid-1",
      );
      expect(row).not.toBeNull();
      expect(row?.status).toBe("unknown");
    });

    it("preserves every FHIR Encounter.status code (planned / arrived / triaged / in-progress / onleave / finished / cancelled / entered-in-error / unknown)", () => {
      const fhirStatuses = [
        "planned",
        "arrived",
        "triaged",
        "in-progress",
        "onleave",
        "finished",
        "cancelled",
        "entered-in-error",
        "unknown",
      ] as const;
      for (const status of fhirStatuses) {
        const row = epicEncounterToRow(
          {
            resourceType: "Encounter",
            id: `enc-${status}`,
            status,
            class: { code: "AMB" },
            subject: { reference: "Patient/p-1" },
            period: { start: "2026-05-20T09:00:00Z" },
          },
          "patient-uuid-1",
        );
        expect(row?.status).toBe(status);
      }
    });

    it("picks the Epic CSN identifier across multiple identifiers", () => {
      const resource: FhirResource = {
        resourceType: "Encounter",
        id: "epic-enc-multi",
        identifier: [
          {
            use: "secondary",
            system: "http://other.example/encounter",
            value: "OTHER-1",
          },
          {
            // Epic CSN — the canonical official identifier.
            use: "official",
            system: "urn:oid:1.2.840.114350.1.13.0.1.7.3.698084.8",
            value: "CSN-9999",
          },
          {
            use: "secondary",
            system: "http://yet.another.example/encounter",
            value: "OTHER-2",
          },
        ],
        status: "finished",
        class: { code: "AMB" },
        subject: { reference: "Patient/p-1" },
        period: { start: "2026-05-20T09:00:00Z" },
      };
      const row = epicEncounterToRow(resource, "patient-uuid-1");
      expect(row?.epic_encounter_id).toBe("CSN-9999");
    });

    it("falls back to the first identifier when no 'official' use is set", () => {
      const resource: FhirResource = {
        resourceType: "Encounter",
        id: "epic-enc-no-official",
        identifier: [
          {
            use: "usual",
            system: "http://example/encounter",
            value: "ANY-1",
          },
        ],
        status: "finished",
        class: { code: "AMB" },
        subject: { reference: "Patient/p-1" },
        period: { start: "2026-05-20T09:00:00Z" },
      };
      const row = epicEncounterToRow(resource, "patient-uuid-1");
      expect(row?.epic_encounter_id).toBe("ANY-1");
    });

    it("returns null when status is missing entirely (resource is unmappable)", () => {
      // FHIR R4 marks Encounter.status as required; a payload without
      // it is structurally broken — refuse to import rather than guess.
      const row = epicEncounterToRow(
        {
          resourceType: "Encounter",
          id: "enc-no-status",
          class: { code: "AMB" },
          subject: { reference: "Patient/p-1" },
          period: { start: "2026-05-20T09:00:00Z" },
        },
        "patient-uuid-1",
      );
      expect(row).toBeNull();
    });

    it("returns null when period.start is missing (encounters table requires start_time)", () => {
      const row = epicEncounterToRow(
        {
          resourceType: "Encounter",
          id: "enc-no-period",
          status: "finished",
          class: { code: "AMB" },
          subject: { reference: "Patient/p-1" },
        },
        "patient-uuid-1",
      );
      expect(row).toBeNull();
    });

    it("defaults encounter_type to 'unknown' when class.code is missing", () => {
      // class is required by FHIR R4 but Epic sometimes returns it
      // empty for stub/placeholder encounters. Fall back rather than
      // refuse to import — class is not a clinical safety field.
      const row = epicEncounterToRow(
        {
          resourceType: "Encounter",
          id: "enc-no-class-code",
          status: "finished",
          subject: { reference: "Patient/p-1" },
          period: { start: "2026-05-20T09:00:00Z" },
        },
        "patient-uuid-1",
      );
      expect(row).not.toBeNull();
      expect(row?.encounter_type).toBe("unknown");
    });

    it("uses coding[].display when reasonCode has no .text", () => {
      const row = epicEncounterToRow(
        {
          resourceType: "Encounter",
          id: "enc-reason-coding",
          status: "finished",
          class: { code: "AMB" },
          subject: { reference: "Patient/p-1" },
          period: { start: "2026-05-20T09:00:00Z" },
          reasonCode: [
            {
              coding: [
                {
                  system: "http://snomed.info/sct",
                  code: "25064002",
                  display: "Headache",
                },
              ],
            },
          ],
        },
        "patient-uuid-1",
      );
      expect(row?.reason).toBe("Headache");
    });
  });

  it("EPIC_SOURCE_SYSTEM_TAG is the string 'epic' (lock-in)", () => {
    // The tag is part of the public contract — downstream queries
    // filter by it. Don't accidentally rename it without coordinating
    // with the sync worker (#391).
    expect(EPIC_SOURCE_SYSTEM_TAG).toBe("epic");
  });
});
