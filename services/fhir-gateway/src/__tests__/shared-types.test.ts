/**
 * Shared FHIR resource types (#1146).
 *
 * Compile-time assertion that the FHIR resource interfaces previously
 * declared inside generator modules now live in the shared
 * `../types/fhir-r4.js` module alongside the other Fhir* resource types.
 * Drift across modules forced PR #1137 to add `meta?: Meta` in three
 * places — keeping these in one file prevents that class of bug.
 *
 * Each assertion checks both that the type is importable from the
 * shared module and that it carries the post-#1137 `meta?: Meta` field.
 */

import { describe, it } from "vitest";
import type {
  FhirCondition,
  FhirAllergyIntolerance,
  FhirObservation,
  Meta,
} from "../types/fhir-r4.js";

describe("shared FHIR resource types (#1146)", () => {
  it("FhirCondition has meta?: Meta", () => {
    type Check = FhirCondition["meta"];
    const _: Meta | undefined = {} as Check;
    void _;
  });

  it("FhirAllergyIntolerance has meta?: Meta", () => {
    type Check = FhirAllergyIntolerance["meta"];
    const _: Meta | undefined = {} as Check;
    void _;
  });

  it("FhirObservation has meta?: Meta", () => {
    type Check = FhirObservation["meta"];
    const _: Meta | undefined = {} as Check;
    void _;
  });
});
