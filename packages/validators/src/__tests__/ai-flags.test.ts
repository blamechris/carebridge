import { describe, it, expect } from "vitest";
import {
  flagSeveritySchema,
  flagCategorySchema,
  flagStatusSchema,
  acknowledgeFlagSchema,
  resolveFlagSchema,
  dismissFlagSchema,
} from "../ai-flags.js";

// ─── Severity Enum ─────────────────────────────────────────────

describe("flagSeveritySchema", () => {
  it("accepts all valid severities", () => {
    for (const severity of ["critical", "warning", "info"]) {
      expect(flagSeveritySchema.safeParse(severity).success, `Expected "${severity}" to pass`).toBe(true);
    }
  });

  it("rejects invalid severities", () => {
    for (const severity of ["high", "low", "error", "CRITICAL", ""]) {
      expect(flagSeveritySchema.safeParse(severity).success, `Expected "${severity}" to fail`).toBe(false);
    }
  });
});

// ─── Category Enum ─────────────────────────────────────────────

describe("flagCategorySchema", () => {
  it("accepts all valid categories", () => {
    const categories = [
      "cross-specialty", "drug-interaction", "medication-safety", "care-gap",
      "critical-value", "trend-concern", "documentation-discrepancy",
    ];
    for (const category of categories) {
      expect(flagCategorySchema.safeParse(category).success, `Expected "${category}" to pass`).toBe(true);
    }
  });

  it("rejects invalid categories", () => {
    for (const category of ["other", "unknown", "drug_interaction", ""]) {
      expect(flagCategorySchema.safeParse(category).success, `Expected "${category}" to fail`).toBe(false);
    }
  });
});

// ─── Status Enum ───────────────────────────────────────────────

describe("flagStatusSchema", () => {
  it("accepts all valid statuses", () => {
    for (const status of ["open", "acknowledged", "resolved", "dismissed", "escalated"]) {
      expect(flagStatusSchema.safeParse(status).success, `Expected "${status}" to pass`).toBe(true);
    }
  });

  it("rejects invalid statuses", () => {
    for (const status of ["closed", "pending", ""]) {
      expect(flagStatusSchema.safeParse(status).success, `Expected "${status}" to fail`).toBe(false);
    }
  });
});

// ─── Acknowledge Flag ──────────────────────────────────────────

describe("acknowledgeFlagSchema", () => {
  it("accepts valid UUID for acknowledged_by", () => {
    const result = acknowledgeFlagSchema.safeParse({
      acknowledged_by: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID acknowledged_by", () => {
    const result = acknowledgeFlagSchema.safeParse({
      acknowledged_by: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing acknowledged_by", () => {
    const result = acknowledgeFlagSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

// ─── Resolve Flag ──────────────────────────────────────────────

describe("resolveFlagSchema", () => {
  const validResolve = {
    resolved_by: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    resolution_note: "Reviewed with attending; no further action needed.",
  };

  it("accepts valid resolve payload", () => {
    const result = resolveFlagSchema.safeParse(validResolve);
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID resolved_by", () => {
    const result = resolveFlagSchema.safeParse({
      ...validResolve,
      resolved_by: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty resolution_note", () => {
    const result = resolveFlagSchema.safeParse({
      ...validResolve,
      resolution_note: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects resolution_note exceeding 2000 characters", () => {
    const result = resolveFlagSchema.safeParse({
      ...validResolve,
      resolution_note: "A".repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts resolution_note of exactly 2000 characters", () => {
    const result = resolveFlagSchema.safeParse({
      ...validResolve,
      resolution_note: "A".repeat(2000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing fields", () => {
    expect(resolveFlagSchema.safeParse({}).success).toBe(false);
  });
});

// ─── Dismiss Flag ──────────────────────────────────────────────

describe("dismissFlagSchema", () => {
  const validDismiss = {
    dismissed_by: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    dismiss_reason: "False positive; patient is not on anticoagulants.",
  };

  it("accepts valid dismiss payload", () => {
    const result = dismissFlagSchema.safeParse(validDismiss);
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID dismissed_by", () => {
    const result = dismissFlagSchema.safeParse({
      ...validDismiss,
      dismissed_by: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty dismiss_reason", () => {
    const result = dismissFlagSchema.safeParse({
      ...validDismiss,
      dismiss_reason: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects dismiss_reason exceeding 2000 characters", () => {
    const result = dismissFlagSchema.safeParse({
      ...validDismiss,
      dismiss_reason: "A".repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});
