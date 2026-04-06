import { describe, it, expect, beforeEach } from "vitest";
import {
  createMedLensToken,
  exportMedications,
  importVitals,
  importLabs,
  revokeToken,
  clearTokenStore,
} from "../medlens-bridge.js";

beforeEach(() => {
  clearTokenStore();
});

describe("createMedLensToken", () => {
  it("returns a token prefixed with ml_", () => {
    const token = createMedLensToken("patient-1", ["read:vitals"]);
    expect(token.token).toMatch(/^ml_[a-f0-9]+$/);
  });

  it("includes requested scopes", () => {
    const token = createMedLensToken("patient-1", [
      "read:vitals",
      "read:medications",
    ]);
    expect(token.scopes).toContain("read:vitals");
    expect(token.scopes).toContain("read:medications");
  });

  it("sets patientId correctly", () => {
    const token = createMedLensToken("patient-42", ["read:vitals"]);
    expect(token.patientId).toBe("patient-42");
  });
});

describe("exportMedications", () => {
  it("requires read:medications scope", () => {
    const token = createMedLensToken("patient-1", ["read:medications"]);
    const result = exportMedications(token.token);
    expect(result.ok).toBe(true);
  });

  it("rejects token without read:medications scope", () => {
    const token = createMedLensToken("patient-1", ["read:vitals"]);
    const result = exportMedications(token.token);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unauthorized");
    }
  });
});

describe("importVitals", () => {
  it("rejects vitals with confidence below 0.6", () => {
    const token = createMedLensToken("patient-1", ["write:vitals"]);
    const result = importVitals(token.token, [
      {
        type: "heart_rate",
        value: 72,
        unit: "bpm",
        confidence: 0.5,
        recordedAt: new Date().toISOString(),
        deviceId: "watch-1",
      },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.rejected).toBe(1);
      expect(result.result.accepted).toBe(0);
    }
  });

  it("accepts vitals with confidence >= 0.6", () => {
    const token = createMedLensToken("patient-1", ["write:vitals"]);
    const result = importVitals(token.token, [
      {
        type: "heart_rate",
        value: 72,
        unit: "bpm",
        confidence: 0.8,
        recordedAt: new Date().toISOString(),
        deviceId: "watch-1",
      },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.accepted).toBe(1);
      expect(result.result.rejected).toBe(0);
    }
  });

  it("accepts vitals at exactly 0.6 threshold", () => {
    const token = createMedLensToken("patient-1", ["write:vitals"]);
    const result = importVitals(token.token, [
      {
        type: "o2_sat",
        value: 98,
        unit: "%",
        confidence: 0.6,
        recordedAt: new Date().toISOString(),
        deviceId: "watch-1",
      },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.accepted).toBe(1);
    }
  });
});

describe("importLabs", () => {
  it("rejects labs with confidence below 0.5", () => {
    const token = createMedLensToken("patient-1", ["write:labs"]);
    const result = importLabs(token.token, [
      {
        testName: "Glucose",
        value: 95,
        unit: "mg/dL",
        confidence: 0.4,
        collectedAt: new Date().toISOString(),
        deviceId: "meter-1",
      },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.rejected).toBe(1);
      expect(result.result.accepted).toBe(0);
    }
  });

  it("accepts labs with confidence >= 0.5", () => {
    const token = createMedLensToken("patient-1", ["write:labs"]);
    const result = importLabs(token.token, [
      {
        testName: "Glucose",
        value: 95,
        unit: "mg/dL",
        confidence: 0.75,
        collectedAt: new Date().toISOString(),
        deviceId: "meter-1",
      },
    ]);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.accepted).toBe(1);
    }
  });
});

describe("revokeToken", () => {
  it("revoked token is rejected for all operations", () => {
    const token = createMedLensToken("patient-1", [
      "read:vitals",
      "read:medications",
      "write:vitals",
    ]);

    revokeToken(token.token);

    const exportResult = exportMedications(token.token);
    expect(exportResult.ok).toBe(false);

    const importResult = importVitals(token.token, []);
    expect(importResult.ok).toBe(false);
  });
});
