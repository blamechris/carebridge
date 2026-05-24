/**
 * US Core vital-signs sub-profile coverage (#1145).
 *
 * US Core 5.x+ defines specialised child profiles per vital type (blood
 * pressure, heart rate, pulse oximetry, etc.) that slice the umbrella
 * `us-core-vital-signs` profile. A fully conformant exporter declares both
 * the umbrella AND the more-specific child profile on `meta.profile`.
 *
 * These tests pin the additive behaviour: the umbrella stays for every
 * vital type, the sub-profile is added when the vital.type maps to one,
 * and an unknown vital.type emits the umbrella alone (no throw).
 *
 * Lab observations are intentionally NOT covered here — they live on a
 * separate `us-core-laboratory-result-observation` code path and have
 * dedicated assertions in `us-core-meta-profile.test.ts`.
 */

import { describe, it, expect } from "vitest";
import { toFhirVitalObservation } from "../generators/observation.js";
import {
  US_CORE_VITAL_SIGNS,
  US_CORE_BLOOD_PRESSURE,
  US_CORE_HEART_RATE,
  US_CORE_PULSE_OXIMETRY,
  US_CORE_RESPIRATORY_RATE,
  US_CORE_BODY_TEMPERATURE,
  US_CORE_BODY_WEIGHT,
  US_CORE_BODY_HEIGHT,
  US_CORE_BMI,
  US_CORE_HEAD_CIRCUMFERENCE,
  US_CORE_VITAL_SUB_PROFILES,
} from "../generators/us-core-profiles.js";
import type { Vital, VitalType } from "@carebridge/shared-types";

function makeVital(overrides: Partial<Vital> & { type: VitalType }): Vital {
  return {
    id: "v1",
    patient_id: "p1",
    value_primary: 0,
    unit: "",
    recorded_at: "2026-05-21T12:00:00.000Z",
    created_at: "2026-05-21T12:00:00.000Z",
    ...overrides,
  } as Vital;
}

describe("US Core vital-signs sub-profiles (#1145)", () => {
  describe("supported vital.type → umbrella + sub-profile", () => {
    const cases: Array<{
      type: VitalType;
      subProfile: string;
      value_primary: number;
      value_secondary?: number;
      unit: string;
    }> = [
      {
        type: "blood_pressure",
        subProfile: US_CORE_BLOOD_PRESSURE,
        value_primary: 120,
        value_secondary: 80,
        unit: "mmHg",
      },
      {
        type: "heart_rate",
        subProfile: US_CORE_HEART_RATE,
        value_primary: 72,
        unit: "bpm",
      },
      {
        type: "o2_sat",
        subProfile: US_CORE_PULSE_OXIMETRY,
        value_primary: 98,
        unit: "%",
      },
      {
        type: "respiratory_rate",
        subProfile: US_CORE_RESPIRATORY_RATE,
        value_primary: 16,
        unit: "breaths/min",
      },
      {
        type: "temperature",
        subProfile: US_CORE_BODY_TEMPERATURE,
        value_primary: 37,
        unit: "Cel",
      },
      {
        type: "weight",
        subProfile: US_CORE_BODY_WEIGHT,
        value_primary: 75,
        unit: "kg",
      },
      {
        type: "body_height",
        subProfile: US_CORE_BODY_HEIGHT,
        value_primary: 175,
        unit: "cm",
      },
      {
        type: "bmi",
        subProfile: US_CORE_BMI,
        value_primary: 24.5,
        unit: "kg/m2",
      },
      {
        type: "head_circumference",
        subProfile: US_CORE_HEAD_CIRCUMFERENCE,
        value_primary: 35,
        unit: "cm",
      },
    ];

    for (const c of cases) {
      it(`${c.type} declares both us-core-vital-signs AND ${c.subProfile.split("/").pop()}`, () => {
        const o = toFhirVitalObservation(makeVital(c), "p1");
        expect(o.meta?.profile).toContain(US_CORE_VITAL_SIGNS);
        expect(o.meta?.profile).toContain(c.subProfile);
        // Order is canonical: umbrella first, sub-profile second.
        expect(o.meta?.profile).toEqual([US_CORE_VITAL_SIGNS, c.subProfile]);
      });
    }
  });

  describe("unsupported vital.type → umbrella only", () => {
    it("pain_level emits the umbrella alone (no sub-profile mapped)", () => {
      const o = toFhirVitalObservation(
        makeVital({ type: "pain_level", value_primary: 4, unit: "/10" }),
        "p1",
      );
      expect(o.meta?.profile).toEqual([US_CORE_VITAL_SIGNS]);
    });

    it("blood_glucose emits the umbrella alone (no sub-profile mapped)", () => {
      const o = toFhirVitalObservation(
        makeVital({
          type: "blood_glucose",
          value_primary: 95,
          unit: "mg/dL",
        }),
        "p1",
      );
      expect(o.meta?.profile).toEqual([US_CORE_VITAL_SIGNS]);
    });

    it("an unknown future vital.type emits the umbrella alone without throwing", () => {
      // Cast through unknown — the production type union does not include
      // future / unrecognised values, but the generator must still be
      // defensive at runtime so an unexpected payload from a legacy import
      // or upstream system does not crash the exporter.
      const unknown = "waist_circumference" as unknown as VitalType;
      const o = toFhirVitalObservation(
        makeVital({
          type: unknown,
          value_primary: 80,
          unit: "cm",
        }),
        "p1",
      );
      expect(o.meta?.profile).toEqual([US_CORE_VITAL_SIGNS]);
    });
  });

  describe("US_CORE_VITAL_SUB_PROFILES lookup", () => {
    it("includes every required US Core 5+ child profile", () => {
      expect(US_CORE_VITAL_SUB_PROFILES.blood_pressure).toBe(
        US_CORE_BLOOD_PRESSURE,
      );
      expect(US_CORE_VITAL_SUB_PROFILES.heart_rate).toBe(US_CORE_HEART_RATE);
      expect(US_CORE_VITAL_SUB_PROFILES.o2_sat).toBe(US_CORE_PULSE_OXIMETRY);
      expect(US_CORE_VITAL_SUB_PROFILES.respiratory_rate).toBe(
        US_CORE_RESPIRATORY_RATE,
      );
      expect(US_CORE_VITAL_SUB_PROFILES.temperature).toBe(
        US_CORE_BODY_TEMPERATURE,
      );
      expect(US_CORE_VITAL_SUB_PROFILES.weight).toBe(US_CORE_BODY_WEIGHT);
      expect(US_CORE_VITAL_SUB_PROFILES.body_height).toBe(US_CORE_BODY_HEIGHT);
      expect(US_CORE_VITAL_SUB_PROFILES.bmi).toBe(US_CORE_BMI);
      expect(US_CORE_VITAL_SUB_PROFILES.head_circumference).toBe(
        US_CORE_HEAD_CIRCUMFERENCE,
      );
    });

    it("all sub-profile URLs share the US Core StructureDefinition base", () => {
      const base = "http://hl7.org/fhir/us/core/StructureDefinition/";
      for (const url of [
        US_CORE_BLOOD_PRESSURE,
        US_CORE_HEART_RATE,
        US_CORE_PULSE_OXIMETRY,
        US_CORE_RESPIRATORY_RATE,
        US_CORE_BODY_TEMPERATURE,
        US_CORE_BODY_WEIGHT,
        US_CORE_BODY_HEIGHT,
        US_CORE_BMI,
        US_CORE_HEAD_CIRCUMFERENCE,
      ]) {
        expect(url.startsWith(base)).toBe(true);
      }
    });

    it("resolves to the canonical US Core sub-profile URLs", () => {
      expect(US_CORE_BLOOD_PRESSURE).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-blood-pressure",
      );
      expect(US_CORE_HEART_RATE).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-heart-rate",
      );
      expect(US_CORE_PULSE_OXIMETRY).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-pulse-oximetry",
      );
      expect(US_CORE_RESPIRATORY_RATE).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-respiratory-rate",
      );
      expect(US_CORE_BODY_TEMPERATURE).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-temperature",
      );
      expect(US_CORE_BODY_WEIGHT).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-weight",
      );
      expect(US_CORE_BODY_HEIGHT).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-body-height",
      );
      expect(US_CORE_BMI).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-bmi",
      );
      expect(US_CORE_HEAD_CIRCUMFERENCE).toBe(
        "http://hl7.org/fhir/us/core/StructureDefinition/us-core-head-circumference",
      );
    });
  });
});
