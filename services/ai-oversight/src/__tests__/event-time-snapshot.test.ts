import { describe, it, expect } from "vitest";

import {
  isoBefore,
  isoLTE,
  isDiagnosisRetracted,
  isAllergyRetracted,
  isMedicationRetracted,
} from "../utils/event-time-snapshot.js";

describe("event-time-snapshot helpers", () => {
  describe("isoBefore", () => {
    it("treats Z-form and equivalent offset-form as equal (not before)", () => {
      // 2026-04-16T07:00-05:00 === 2026-04-16T12:00Z
      expect(
        isoBefore("2026-04-16T07:00:00.000-05:00", "2026-04-16T12:00:00.000Z"),
      ).toBe(false);
      expect(
        isoBefore("2026-04-16T12:00:00.000Z", "2026-04-16T07:00:00.000-05:00"),
      ).toBe(false);
    });

    it("returns true when a is genuinely earlier across timezone forms", () => {
      expect(
        isoBefore("2026-04-16T06:00:00.000-05:00", "2026-04-16T12:00:00.000Z"),
      ).toBe(true);
    });

    it("handles millisecond precision correctly", () => {
      expect(
        isoBefore("2026-04-16T12:00:00.000Z", "2026-04-16T12:00:00.001Z"),
      ).toBe(true);
      expect(
        isoBefore("2026-04-16T12:00:00.001Z", "2026-04-16T12:00:00.000Z"),
      ).toBe(false);
    });

    it("treats bare dates as UTC midnight", () => {
      expect(isoBefore("2026-04-15", "2026-04-16T00:00:00.000Z")).toBe(true);
      expect(isoBefore("2026-04-16", "2026-04-16T00:00:00.000Z")).toBe(false);
    });

    it("returns false for null / undefined / garbage operands", () => {
      expect(isoBefore(null, "2026-04-16T12:00:00.000Z")).toBe(false);
      expect(isoBefore(undefined, "2026-04-16T12:00:00.000Z")).toBe(false);
      expect(isoBefore("not-a-date", "2026-04-16T12:00:00.000Z")).toBe(false);
    });
  });

  describe("isoLTE", () => {
    it("returns true when operands represent the same instant across suffixes", () => {
      expect(
        isoLTE("2026-04-16T07:00:00.000-05:00", "2026-04-16T12:00:00.000Z"),
      ).toBe(true);
      expect(
        isoLTE("2026-04-16T12:00:00.000Z", "2026-04-16T07:00:00.000-05:00"),
      ).toBe(true);
    });

    it("returns false for null / undefined / garbage operands", () => {
      expect(isoLTE(null, "2026-04-16T12:00:00.000Z")).toBe(false);
      expect(isoLTE("not-a-date", "2026-04-16T12:00:00.000Z")).toBe(false);
    });
  });

  describe("isDiagnosisRetracted", () => {
    it("returns true only for status=entered_in_error", () => {
      expect(isDiagnosisRetracted({ status: "entered_in_error" })).toBe(true);
      expect(isDiagnosisRetracted({ status: "active" })).toBe(false);
      expect(isDiagnosisRetracted({ status: "chronic" })).toBe(false);
      expect(isDiagnosisRetracted({ status: "resolved" })).toBe(false);
      expect(isDiagnosisRetracted({ status: null })).toBe(false);
      expect(isDiagnosisRetracted({})).toBe(false);
    });
  });

  describe("isAllergyRetracted", () => {
    it("returns true for entered_in_error and refuted", () => {
      expect(isAllergyRetracted({ verification_status: "entered_in_error" })).toBe(true);
      expect(isAllergyRetracted({ verification_status: "refuted" })).toBe(true);
    });

    it("returns false for confirmed / unconfirmed / null", () => {
      expect(isAllergyRetracted({ verification_status: "confirmed" })).toBe(false);
      expect(isAllergyRetracted({ verification_status: "unconfirmed" })).toBe(false);
      expect(isAllergyRetracted({ verification_status: null })).toBe(false);
      expect(isAllergyRetracted({})).toBe(false);
    });
  });

  describe("isMedicationRetracted", () => {
    it("returns true only for status=entered_in_error", () => {
      expect(isMedicationRetracted({ status: "entered_in_error" })).toBe(true);
    });

    it("returns false for active / completed / stopped / null", () => {
      expect(isMedicationRetracted({ status: "active" })).toBe(false);
      expect(isMedicationRetracted({ status: "completed" })).toBe(false);
      expect(isMedicationRetracted({ status: "stopped" })).toBe(false);
      expect(isMedicationRetracted({ status: null })).toBe(false);
      expect(isMedicationRetracted({})).toBe(false);
    });
  });
});
