/**
 * US Core meta.profile coverage (#938).
 *
 * Every exported FHIR resource must declare conformance to a US Core
 * StructureDefinition via `resource.meta.profile`. These tests pin the
 * expected profile URL per generator so a regression — dropping the meta
 * block, swapping the URL, or forgetting to update a new generator — fails
 * loudly rather than shipping a silently non-conformant export.
 *
 * Practitioner declares `us-core-practitioner` per-row only when both
 * NPI and NUCC qualification coding are present (#947); coverage for
 * the both-present and both-absent cases lives in practitioner.test.ts
 * since the gate is row-shape dependent rather than blanket.
 * MedicationStatement is intentionally excluded — US Core 5+ deprecated the
 * profile and no canonical URL exists; documented in us-core-profiles.ts.
 */

import { describe, it, expect } from "vitest";
import { toFhirPatient } from "../generators/patient.js";
import { toFhirCondition } from "../generators/condition.js";
import { toFhirMedicationRequest } from "../generators/medication-request.js";
import { toFhirMedicationStatement } from "../generators/medication-statement.js";
import { toFhirAllergyIntolerance } from "../generators/allergy-intolerance.js";
import {
  toFhirVitalObservation,
  toFhirLabObservation,
} from "../generators/observation.js";
import { toFhirEncounter } from "../generators/encounter.js";
import { toFhirProcedure } from "../generators/procedure.js";
import {
  US_CORE_PATIENT,
  US_CORE_CONDITION,
  US_CORE_MEDICATION_REQUEST,
  US_CORE_ALLERGY_INTOLERANCE,
  US_CORE_VITAL_SIGNS,
  US_CORE_LABORATORY_RESULT,
  US_CORE_ENCOUNTER,
  US_CORE_PROCEDURE,
  US_CORE_PRACTITIONER,
} from "../generators/us-core-profiles.js";
import type { Vital, LabResult } from "@carebridge/shared-types";

// ── Builders (one per generator) ───────────────────────────────────────────

type Patient = Parameters<typeof toFhirPatient>[0];
function makePatient(): Patient {
  return {
    id: "pat-1",
    name: "Jane Doe",
    date_of_birth: "1980-05-12",
    biological_sex: "female",
    mrn: "MRN-12345",
  };
}

type Diagnosis = Parameters<typeof toFhirCondition>[0];
function makeDiagnosis(): Diagnosis {
  return {
    id: "d1",
    patient_id: "p1",
    description: "Type 2 diabetes",
    icd10_code: "E11.9",
    snomed_code: null,
    status: "active",
    onset_date: "2020-01-01",
    resolved_date: null,
    diagnosed_by: null,
    notes: null,
    source_system: "internal",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
  } as Diagnosis;
}

type Medication = Parameters<typeof toFhirMedicationRequest>[0];
function makeMedication(): Medication {
  return {
    id: "m1",
    patient_id: "p1",
    name: "Amoxicillin",
    brand_name: null,
    dose_amount: 500,
    dose_unit: "mg",
    route: "oral",
    frequency: "TID",
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
  } as Medication;
}

type Allergy = Parameters<typeof toFhirAllergyIntolerance>[0];
function makeAllergy(): Allergy {
  return {
    id: "a1",
    allergen: "Peanut",
    snomed_code: "91935009",
    rxnorm_code: null,
    reaction: null,
    severity: null,
    source_system: "internal",
    created_at: "2026-01-01T00:00:00.000Z",
  } as Allergy;
}

function makeVital(): Vital {
  return {
    id: "v1",
    patient_id: "p1",
    type: "heart_rate",
    value_primary: 72,
    unit: "bpm",
    recorded_at: "2026-05-21T12:00:00.000Z",
    created_at: "2026-05-21T12:00:00.000Z",
  };
}

function makeLab(): LabResult {
  return {
    id: "l1",
    panel_id: "panel-1",
    test_name: "Hemoglobin",
    test_code: "718-7",
    value: 14.2,
    unit: "g/dL",
    reference_low: 12,
    reference_high: 17,
    created_at: "2026-05-21T12:00:00.000Z",
  };
}

type EncounterRow = Parameters<typeof toFhirEncounter>[0];
function makeEncounter(): EncounterRow {
  return {
    id: "e1",
    patient_id: "p1",
    encounter_type: "outpatient",
    status: "finished",
    start_time: "2026-04-10T10:00:00.000Z",
    end_time: "2026-04-10T10:45:00.000Z",
    provider_id: null,
    location: null,
    reason: null,
    notes: null,
    source_system: "internal",
    created_at: "2026-04-10T10:00:00.000Z",
  } as EncounterRow;
}

type ProcedureRow = Parameters<typeof toFhirProcedure>[0];
function makeProcedure(): ProcedureRow {
  return {
    id: "p1",
    patient_id: "p1",
    name: "Appendectomy",
    cpt_code: "44970",
    icd10_codes: ["K35.80"],
    status: "completed",
    performed_at: "2026-04-10T14:00:00.000Z",
    performed_by: null,
    provider_id: null,
    encounter_id: null,
    notes: null,
    source_system: "internal",
    created_at: "2026-04-10T14:00:00.000Z",
  } as ProcedureRow;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("US Core meta.profile (#938)", () => {
  describe("Patient", () => {
    it("emits the US Core Patient profile URL", () => {
      const p = toFhirPatient(makePatient());
      expect(p.meta?.profile).toEqual([US_CORE_PATIENT]);
      expect(p.meta?.profile?.[0]).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-patient",
      );
    });
  });

  describe("Condition", () => {
    it("emits the US Core Condition (encounter-diagnosis) profile URL", () => {
      const c = toFhirCondition(makeDiagnosis(), "p1");
      expect(c.meta?.profile).toEqual([US_CORE_CONDITION]);
      expect(c.meta?.profile?.[0]).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-condition-encounter-diagnosis",
      );
    });
  });

  describe("MedicationRequest", () => {
    it("emits the US Core MedicationRequest profile URL", () => {
      const r = toFhirMedicationRequest(makeMedication(), "p1");
      expect(r.meta?.profile).toEqual([US_CORE_MEDICATION_REQUEST]);
      expect(r.meta?.profile?.[0]).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-medicationrequest",
      );
    });
  });

  describe("MedicationStatement", () => {
    it("does NOT declare a US Core profile (deprecated in US Core 5+)", () => {
      const s = toFhirMedicationStatement(makeMedication(), "p1");
      // MedicationStatement has no current US Core profile; emitting one
      // would be a false conformance claim. The local resource type doesn't
      // even carry a meta property — confirm it's truly absent rather than
      // empty.
      const meta = (s as { meta?: unknown }).meta;
      expect(meta).toBeUndefined();
    });
  });

  describe("AllergyIntolerance", () => {
    it("emits the US Core AllergyIntolerance profile URL", () => {
      const a = toFhirAllergyIntolerance(makeAllergy(), "p1");
      expect(a.meta?.profile).toEqual([US_CORE_ALLERGY_INTOLERANCE]);
      expect(a.meta?.profile?.[0]).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-allergyintolerance",
      );
    });
  });

  describe("Observation (vital)", () => {
    it("emits the US Core Vital Signs umbrella profile URL", () => {
      const o = toFhirVitalObservation(makeVital(), "p1");
      // makeVital() builds a heart_rate vital, which maps to a sub-profile
      // (#1145). The umbrella us-core-vital-signs MUST still be present
      // alongside the heart-rate child profile.
      expect(o.meta?.profile).toContain(US_CORE_VITAL_SIGNS);
      expect(o.meta?.profile?.[0]).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-vital-signs",
      );
    });
  });

  describe("Observation (lab result)", () => {
    it("emits the US Core Laboratory Result Observation profile URL", () => {
      const o = toFhirLabObservation(makeLab(), "p1");
      expect(o.meta?.profile).toEqual([US_CORE_LABORATORY_RESULT]);
      expect(o.meta?.profile?.[0]).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-laboratory-result-observation",
      );
    });

    it("does NOT emit the vital-signs profile on a lab observation", () => {
      const o = toFhirLabObservation(makeLab(), "p1");
      expect(o.meta?.profile).not.toContain(US_CORE_VITAL_SIGNS);
    });
  });

  describe("Encounter", () => {
    it("emits the US Core Encounter profile URL", () => {
      const e = toFhirEncounter(makeEncounter(), "p1");
      expect(e.meta?.profile).toEqual([US_CORE_ENCOUNTER]);
      expect(e.meta?.profile?.[0]).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-encounter",
      );
    });
  });

  describe("Procedure", () => {
    it("emits the US Core Procedure profile URL", () => {
      const p = toFhirProcedure(makeProcedure(), "p1");
      expect(p.meta?.profile).toEqual([US_CORE_PROCEDURE]);
      expect(p.meta?.profile?.[0]).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-procedure",
      );
    });
  });

  describe("profile URL constants", () => {
    it("all URLs share the US Core StructureDefinition base", () => {
      const base = "http://hl7.org/fhir/us/core/StructureDefinition/";
      for (const url of [
        US_CORE_PATIENT,
        US_CORE_CONDITION,
        US_CORE_MEDICATION_REQUEST,
        US_CORE_ALLERGY_INTOLERANCE,
        US_CORE_VITAL_SIGNS,
        US_CORE_LABORATORY_RESULT,
        US_CORE_ENCOUNTER,
        US_CORE_PROCEDURE,
        US_CORE_PRACTITIONER,
      ]) {
        expect(url.startsWith(base)).toBe(true);
      }
    });

    it("US_CORE_PRACTITIONER resolves to the canonical us-core-practitioner URL", () => {
      expect(US_CORE_PRACTITIONER).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-practitioner",
      );
    });
  });
});
