/**
 * Unit tests for `parseEpicPatientParam` (#1188).
 *
 * The helper is the single source of truth for the FHIR-id grammar
 * applied to the `?epic_patient` query param before it leaves the
 * clinician portal. The acceptance bar mirrors FHIR R4 §2.36.1.4 plus
 * the additional defence-in-depth requirements called out in the
 * issue: reject empty input, reject anything outside `[A-Za-z0-9.-]`,
 * cap at 64 characters.
 */
import { describe, it, expect } from "vitest";
import {
  parseEpicPatientParam,
  FHIR_ID_MAX_LENGTH,
} from "../lib/epic-launch";

describe("parseEpicPatientParam (#1188)", () => {
  it("returns undefined for null", () => {
    expect(parseEpicPatientParam(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(parseEpicPatientParam(undefined)).toBeUndefined();
  });

  it("returns undefined for an empty string", () => {
    expect(parseEpicPatientParam("")).toBeUndefined();
  });

  it("accepts a plain alphanumeric FHIR id", () => {
    expect(parseEpicPatientParam("ePatient123")).toBe("ePatient123");
  });

  it("accepts hyphens and dots (FHIR-allowed separators)", () => {
    expect(parseEpicPatientParam("a-b.c-1")).toBe("a-b.c-1");
  });

  it("rejects whitespace", () => {
    expect(parseEpicPatientParam("eP 1")).toBeUndefined();
  });

  it("rejects HTML/script-injection characters", () => {
    expect(parseEpicPatientParam("<script>")).toBeUndefined();
    expect(parseEpicPatientParam("a&b")).toBeUndefined();
    expect(parseEpicPatientParam("a/b")).toBeUndefined();
  });

  it("rejects underscore and other non-FHIR punctuation", () => {
    expect(parseEpicPatientParam("a_b")).toBeUndefined();
    expect(parseEpicPatientParam("a:b")).toBeUndefined();
  });

  it("accepts a 64-character id (boundary)", () => {
    const id = "a".repeat(FHIR_ID_MAX_LENGTH);
    expect(parseEpicPatientParam(id)).toBe(id);
  });

  it("rejects a 65-character id (just over the boundary)", () => {
    const id = "a".repeat(FHIR_ID_MAX_LENGTH + 1);
    expect(parseEpicPatientParam(id)).toBeUndefined();
  });
});
