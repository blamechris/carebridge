import { beforeEach, describe, expect, it } from "vitest";
import {
  formatPrometheus,
  getMetricsSnapshot,
  recordFlagCreated,
  recordFlagDismissed,
  recordFlagResolved,
  resetMetrics,
} from "../services/shadow-metrics.js";

describe("formatPrometheus", () => {
  beforeEach(() => {
    resetMetrics();
  });

  it("emits HELP/TYPE headers and counter lines for recorded flags", () => {
    recordFlagCreated({ rule_id: "ONCO-VTE-NEURO-001", source: "rules" });
    recordFlagCreated({ rule_id: "ONCO-VTE-NEURO-001", source: "rules" });
    recordFlagDismissed({ rule_id: "ONCO-VTE-NEURO-001", source: "rules" });
    recordFlagResolved({ rule_id: "ONCO-VTE-NEURO-001", source: "rules" });
    recordFlagCreated({ source: "ai-review" });

    const out = formatPrometheus(getMetricsSnapshot());

    expect(out).toContain("# HELP carebridge_flag_created_total Number of clinical flags created");
    expect(out).toContain("# TYPE carebridge_flag_created_total counter");
    expect(out).toContain("# HELP carebridge_flag_dismissed_total");
    expect(out).toContain("# HELP carebridge_flag_resolved_total");
    expect(out).toContain("# HELP carebridge_flag_dismiss_rate");
    expect(out).toContain("# TYPE carebridge_flag_dismiss_rate gauge");

    expect(out).toContain('carebridge_flag_created_total{rule_id="ONCO-VTE-NEURO-001"} 2');
    expect(out).toContain('carebridge_flag_dismissed_total{rule_id="ONCO-VTE-NEURO-001"} 1');
    expect(out).toContain('carebridge_flag_resolved_total{rule_id="ONCO-VTE-NEURO-001"} 1');
    expect(out).toContain('carebridge_flag_created_total{source="rules"} 2');
    expect(out).toContain('carebridge_flag_created_total{source="ai-review"} 1');
    expect(out).toContain('carebridge_flag_dismiss_rate{rule_id="ONCO-VTE-NEURO-001"} 0.5');
  });

  it("escapes quotes, backslashes, and newlines in label values", () => {
    recordFlagCreated({ rule_id: 'EVIL"RULE\\X\nY', source: "rules" });
    const out = formatPrometheus(getMetricsSnapshot());
    expect(out).toContain('rule_id="EVIL\\"RULE\\\\X\\nY"');
  });
});
