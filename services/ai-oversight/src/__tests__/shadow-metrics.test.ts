import { describe, it, expect, beforeEach } from "vitest";
import {
  recordFlagCreated,
  recordFlagDismissed,
  recordFlagResolved,
  getMetricsSnapshot,
  resetMetrics,
} from "../services/shadow-metrics.js";

beforeEach(() => resetMetrics());

describe("shadow-metrics — flag precision/recall tracking", () => {
  it("tracks flag creation by rule_id and source", () => {
    recordFlagCreated({ rule_id: "ONCO-VTE-NEURO-001", source: "rules" });
    recordFlagCreated({ rule_id: "ONCO-VTE-NEURO-001", source: "rules" });
    recordFlagCreated({ source: "ai-review" });
    const snap = getMetricsSnapshot();
    expect(snap.byRule["ONCO-VTE-NEURO-001"].created).toBe(2);
    expect(snap.bySource["ai-review"].created).toBe(1);
  });

  it("computes dismiss-rate per rule for alert-fatigue tracking", () => {
    recordFlagCreated({ rule_id: "CHEMO-FEVER-001", source: "rules" });
    recordFlagCreated({ rule_id: "CHEMO-FEVER-001", source: "rules" });
    recordFlagCreated({ rule_id: "CHEMO-FEVER-001", source: "rules" });
    recordFlagDismissed({ rule_id: "CHEMO-FEVER-001" });
    recordFlagDismissed({ rule_id: "CHEMO-FEVER-001" });
    const snap = getMetricsSnapshot();
    expect(snap.byRule["CHEMO-FEVER-001"].dismissed).toBe(2);
    expect(snap.byRule["CHEMO-FEVER-001"].dismissRate).toBeCloseTo(2 / 3);
  });

  it("counts resolutions distinctly from dismissals", () => {
    recordFlagCreated({ rule_id: "R1", source: "rules" });
    recordFlagResolved({ rule_id: "R1" });
    const snap = getMetricsSnapshot();
    expect(snap.byRule["R1"].resolved).toBe(1);
    expect(snap.byRule["R1"].dismissed).toBe(0);
  });

  it("resetMetrics zeros all counters", () => {
    recordFlagCreated({ rule_id: "R1", source: "rules" });
    resetMetrics();
    expect(getMetricsSnapshot().byRule).toEqual({});
  });
});
