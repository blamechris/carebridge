/**
 * Shadow-mode metrics for clinical flag precision/recall tracking.
 *
 * In-process counters for flag creation, dismissal, and resolution by rule
 * and by source. Used to detect alert fatigue and to evaluate new rules
 * before they are promoted from shadow mode to production.
 *
 * NOT a substitute for a real time-series store — these counters reset on
 * process restart. Intended to be scraped by a Prometheus exporter or
 * periodically flushed to the audit DB.
 */

import type { FlagSource } from "@carebridge/shared-types";

interface RuleCounters {
  created: number;
  dismissed: number;
  resolved: number;
}

interface SourceCounters {
  created: number;
  dismissed: number;
  resolved: number;
}

interface RuleSnapshot extends RuleCounters {
  dismissRate: number;
}

interface MetricsSnapshot {
  byRule: Record<string, RuleSnapshot>;
  bySource: Record<string, SourceCounters>;
}

const byRule = new Map<string, RuleCounters>();
const bySource = new Map<string, SourceCounters>();

function ruleBucket(ruleId: string): RuleCounters {
  let b = byRule.get(ruleId);
  if (!b) {
    b = { created: 0, dismissed: 0, resolved: 0 };
    byRule.set(ruleId, b);
  }
  return b;
}

function sourceBucket(source: string): SourceCounters {
  let b = bySource.get(source);
  if (!b) {
    b = { created: 0, dismissed: 0, resolved: 0 };
    bySource.set(source, b);
  }
  return b;
}

export function recordFlagCreated(input: {
  rule_id?: string;
  source: FlagSource;
}): void {
  if (input.rule_id) ruleBucket(input.rule_id).created++;
  sourceBucket(input.source).created++;
}

export function recordFlagDismissed(input: { rule_id?: string; source?: FlagSource }): void {
  if (input.rule_id) ruleBucket(input.rule_id).dismissed++;
  if (input.source) sourceBucket(input.source).dismissed++;
}

export function recordFlagResolved(input: { rule_id?: string; source?: FlagSource }): void {
  if (input.rule_id) ruleBucket(input.rule_id).resolved++;
  if (input.source) sourceBucket(input.source).resolved++;
}

export function getMetricsSnapshot(): MetricsSnapshot {
  const ruleSnap: Record<string, RuleSnapshot> = {};
  for (const [id, c] of byRule) {
    ruleSnap[id] = {
      ...c,
      dismissRate: c.created > 0 ? c.dismissed / c.created : 0,
    };
  }
  const sourceSnap: Record<string, SourceCounters> = {};
  for (const [s, c] of bySource) sourceSnap[s] = { ...c };
  return { byRule: ruleSnap, bySource: sourceSnap };
}

export function resetMetrics(): void {
  byRule.clear();
  bySource.clear();
}
