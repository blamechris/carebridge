import { describe, it, expect } from "vitest";
import {
  getStalenessThreshold,
  DEFAULT_STALENESS_THRESHOLD,
  VITAL_STALENESS_THRESHOLDS,
} from "../vital-staleness-thresholds.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe("getStalenessThreshold", () => {
  it("returns default thresholds when no vital type is provided", () => {
    expect(getStalenessThreshold()).toEqual(DEFAULT_STALENESS_THRESHOLD);
    expect(getStalenessThreshold(undefined)).toEqual(
      DEFAULT_STALENESS_THRESHOLD,
    );
  });

  it("returns default thresholds for unknown vital types", () => {
    expect(getStalenessThreshold("unknown_type")).toEqual(
      DEFAULT_STALENESS_THRESHOLD,
    );
  });

  it("returns 4h/24h for blood_pressure", () => {
    const t = getStalenessThreshold("blood_pressure");
    expect(t.overdueMs).toBe(4 * HOUR);
    expect(t.staleMs).toBe(24 * HOUR);
  });

  it("returns 4h/24h for heart_rate", () => {
    const t = getStalenessThreshold("heart_rate");
    expect(t.overdueMs).toBe(4 * HOUR);
    expect(t.staleMs).toBe(24 * HOUR);
  });

  it("returns 4h/24h for temperature", () => {
    const t = getStalenessThreshold("temperature");
    expect(t.overdueMs).toBe(4 * HOUR);
    expect(t.staleMs).toBe(24 * HOUR);
  });

  it("returns 24h/7d for weight", () => {
    const t = getStalenessThreshold("weight");
    expect(t.overdueMs).toBe(24 * HOUR);
    expect(t.staleMs).toBe(7 * DAY);
  });

  it("returns 4h/24h for o2_sat", () => {
    const t = getStalenessThreshold("o2_sat");
    expect(t.overdueMs).toBe(4 * HOUR);
    expect(t.staleMs).toBe(24 * HOUR);
  });

  it("returns 4h/24h for respiratory_rate", () => {
    const t = getStalenessThreshold("respiratory_rate");
    expect(t.overdueMs).toBe(4 * HOUR);
    expect(t.staleMs).toBe(24 * HOUR);
  });
});

describe("VITAL_STALENESS_THRESHOLDS", () => {
  it("has overdueMs < staleMs for every defined threshold", () => {
    for (const [type, threshold] of Object.entries(
      VITAL_STALENESS_THRESHOLDS,
    )) {
      expect(threshold!.overdueMs).toBeLessThan(threshold!.staleMs);
    }
  });
});
