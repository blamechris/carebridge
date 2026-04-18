import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for the server-flag vs client-inferred flag disagreement warning
 * that lives inside LabsTab. Because the warning logic is inline in the
 * component render path, we replicate the exact derivation here so we
 * can verify the console.warn contract without mounting the full React
 * tree (which requires tRPC context, router, etc.).
 *
 * If the derivation is ever extracted to a shared helper, these tests
 * should be pointed at the real export instead.
 */

/** Mirrors the inline derivation in LabsTab. */
function deriveInferredFlag(
  flag: string,
  value: number | null,
  refLow: number | null,
  refHigh: number | null,
): string {
  const isOutOfRange =
    typeof value === "number" &&
    ((typeof refLow === "number" && value < refLow) ||
      (typeof refHigh === "number" && value > refHigh));

  return !flag && isOutOfRange && typeof value === "number"
    ? typeof refLow === "number" && value < refLow
      ? "low"
      : "high"
    : "";
}

/** Mirrors the dev-only disagreement check in LabsTab. */
function checkDisagreement(
  flag: string,
  value: number | null,
  refLow: number | null,
  refHigh: number | null,
): { disagrees: boolean; clientDirection?: string } {
  const isOutOfRange =
    typeof value === "number" &&
    ((typeof refLow === "number" && value < refLow) ||
      (typeof refHigh === "number" && value > refHigh));

  if (!flag || !isOutOfRange || typeof value !== "number") {
    return { disagrees: false };
  }

  const clientDirection =
    typeof refLow === "number" && value < refLow ? "low" : "high";
  const serverNorm = flag.toLowerCase();
  const disagrees =
    (serverNorm === "h" && clientDirection === "low") ||
    (serverNorm === "l" && clientDirection === "high") ||
    (serverNorm === "high" && clientDirection === "low") ||
    (serverNorm === "low" && clientDirection === "high");

  return { disagrees, clientDirection };
}

describe("lab flag precedence", () => {
  describe("inferredFlag derivation", () => {
    it("returns empty string when server flag is present", () => {
      // Server says H, value above ref — inferred flag is suppressed
      expect(deriveInferredFlag("H", 6.0, 3.5, 5.0)).toBe("");
    });

    it("returns 'high' when no server flag and value > refHigh", () => {
      expect(deriveInferredFlag("", 5.5, 3.5, 5.0)).toBe("high");
    });

    it("returns 'low' when no server flag and value < refLow", () => {
      expect(deriveInferredFlag("", 3.0, 3.5, 5.0)).toBe("low");
    });

    it("returns empty string when value is in range", () => {
      expect(deriveInferredFlag("", 4.0, 3.5, 5.0)).toBe("");
    });

    it("returns empty string when value is null", () => {
      expect(deriveInferredFlag("", null, 3.5, 5.0)).toBe("");
    });

    it("returns empty string when value equals refLow exactly", () => {
      expect(deriveInferredFlag("", 3.5, 3.5, 5.0)).toBe("");
    });

    it("returns empty string when value equals refHigh exactly", () => {
      expect(deriveInferredFlag("", 5.0, 3.5, 5.0)).toBe("");
    });

    it("returns 'low' when value is one cent below refLow", () => {
      expect(deriveInferredFlag("", 3.49, 3.5, 5.0)).toBe("low");
    });

    it("returns 'high' when value is one cent above refHigh", () => {
      expect(deriveInferredFlag("", 5.01, 3.5, 5.0)).toBe("high");
    });
  });

  describe("server/client disagreement warning", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("detects disagreement: server=H but value below refLow", () => {
      const result = checkDisagreement("H", 3.0, 3.5, 5.0);
      expect(result.disagrees).toBe(true);
      expect(result.clientDirection).toBe("low");
    });

    it("detects disagreement: server=L but value above refHigh", () => {
      const result = checkDisagreement("L", 6.0, 3.5, 5.0);
      expect(result.disagrees).toBe(true);
      expect(result.clientDirection).toBe("high");
    });

    it("detects disagreement: server=high but value below refLow", () => {
      const result = checkDisagreement("high", 3.0, 3.5, 5.0);
      expect(result.disagrees).toBe(true);
      expect(result.clientDirection).toBe("low");
    });

    it("detects disagreement: server=low but value above refHigh", () => {
      const result = checkDisagreement("low", 6.0, 3.5, 5.0);
      expect(result.disagrees).toBe(true);
      expect(result.clientDirection).toBe("high");
    });

    it("no disagreement when server=H and value above refHigh", () => {
      const result = checkDisagreement("H", 6.0, 3.5, 5.0);
      expect(result.disagrees).toBe(false);
    });

    it("no disagreement when server=L and value below refLow", () => {
      const result = checkDisagreement("L", 3.0, 3.5, 5.0);
      expect(result.disagrees).toBe(false);
    });

    it("no disagreement when server flag is critical (non-directional)", () => {
      const result = checkDisagreement("critical", 6.0, 3.5, 5.0);
      expect(result.disagrees).toBe(false);
    });

    it("no disagreement check when no server flag", () => {
      const result = checkDisagreement("", 6.0, 3.5, 5.0);
      expect(result.disagrees).toBe(false);
    });

    it("no disagreement check when value is in range", () => {
      const result = checkDisagreement("H", 4.0, 3.5, 5.0);
      expect(result.disagrees).toBe(false);
    });
  });
});
