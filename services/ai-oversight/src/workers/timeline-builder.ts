/**
 * Phase A3: temporal context window.
 *
 * Pure assembly + analysis helpers that turn the modality-siloed slices
 * we already fetch (vitals, labs, meds, notes, encounters) into a
 * unified 30-day TimelineEvent[] plus same-day / same-week clusters and
 * a deterministic care-gap pre-pass.
 *
 * Keeping this module database-free makes it trivially unit-testable
 * and reusable by the rule engine if it ever wants the same view.
 */

import type {
  TimelineEvent,
  TemporalCluster,
  GapDetected,
} from "@carebridge/ai-prompts";

/** Default temporal window: last 30 days. */
export const TIMELINE_WINDOW_DAYS = 30;
export const TIMELINE_WINDOW_MS = TIMELINE_WINDOW_DAYS * 24 * 60 * 60 * 1000;

/** Minimum events on the same calendar day to count as a same-day cluster. */
export const SAME_DAY_CLUSTER_THRESHOLD = 3;
/** Minimum events in any rolling 7-day window to count as a same-week cluster. */
export const SAME_WEEK_CLUSTER_THRESHOLD = 5;

/** Stale-vitals gap threshold in days. */
export const STALE_VITALS_DAYS = 14;
/** Stale-note gap threshold in days for patients with active diagnoses. */
export const STALE_NOTE_DAYS = 30;

/**
 * Input shape accepted by `assembleTimeline`. Each array is a minimal
 * projection of the corresponding table row — only the fields the
 * timeline actually renders, so callers can map from whatever their
 * drizzle select returned without leaking PHI-bearing columns.
 */
export interface TimelineInputs {
  vitals: Array<{
    recorded_at: string;
    type: string;
    value_primary: number;
    unit: string;
  }>;
  lab_panels: Array<{
    collected_at: string | null;
    panel_name: string;
    abnormal_count?: number;
  }>;
  medications: Array<{
    started_at: string | null;
    name: string;
    dose_amount: number | null;
    dose_unit: string | null;
    status: string;
  }>;
  notes: Array<{
    created_at: string;
    signed_at?: string | null;
    template_type: string;
    provider_specialty?: string | null;
    status: string;
  }>;
  encounters: Array<{
    start_time: string;
    encounter_type: string;
    reason?: string | null;
    provider_specialty?: string | null;
  }>;
}

/**
 * Fold the heterogeneous inputs into a single chronologically-sorted
 * TimelineEvent[] containing only events that fall within the window.
 * `nowIso` is injectable for deterministic tests.
 */
export function assembleTimeline(
  inputs: TimelineInputs,
  nowIso: string = new Date().toISOString(),
): TimelineEvent[] {
  const now = Date.parse(nowIso);
  const windowStart = now - TIMELINE_WINDOW_MS;

  const inWindow = (iso: string | null | undefined): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return false;
    return t >= windowStart && t <= now;
  };

  const events: TimelineEvent[] = [];

  for (const v of inputs.vitals) {
    if (!inWindow(v.recorded_at)) continue;
    events.push({
      at: v.recorded_at,
      category: "vital",
      detail: `${v.type}: ${v.value_primary} ${v.unit}`.trim(),
    });
  }

  for (const p of inputs.lab_panels) {
    if (!inWindow(p.collected_at)) continue;
    const abnormal =
      typeof p.abnormal_count === "number" && p.abnormal_count > 0
        ? ` (${p.abnormal_count} abnormal)`
        : "";
    events.push({
      at: p.collected_at as string,
      category: "lab",
      detail: `${p.panel_name}${abnormal}`,
      severity:
        typeof p.abnormal_count === "number" && p.abnormal_count > 0
          ? "warning"
          : undefined,
    });
  }

  for (const m of inputs.medications) {
    if (!inWindow(m.started_at)) continue;
    const dose =
      m.dose_amount != null && m.dose_unit
        ? ` ${m.dose_amount} ${m.dose_unit}`
        : "";
    events.push({
      at: m.started_at as string,
      category: "medication",
      detail: `${m.status} — ${m.name}${dose}`,
    });
  }

  for (const n of inputs.notes) {
    const ts = n.signed_at ?? n.created_at;
    if (!inWindow(ts)) continue;
    events.push({
      at: ts,
      category: "note",
      detail: `${n.template_type} ${n.status}`,
      specialty: n.provider_specialty ?? undefined,
    });
  }

  for (const e of inputs.encounters) {
    if (!inWindow(e.start_time)) continue;
    events.push({
      at: e.start_time,
      category: "encounter",
      detail: `${e.encounter_type}${e.reason ? ` — ${e.reason}` : ""}`,
      specialty: e.provider_specialty ?? undefined,
    });
  }

  // Sort ascending so the prompt reads oldest → newest — the LLM
  // follows the patient's recent story forward in time.
  events.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  return events;
}

/**
 * Detect same-day and same-week event bursts over an already-assembled
 * timeline. A same-day cluster requires at least
 * SAME_DAY_CLUSTER_THRESHOLD events on the same calendar date; a
 * same-week cluster requires at least SAME_WEEK_CLUSTER_THRESHOLD
 * events in any rolling 7-day window that isn't already covered by a
 * same-day cluster. The goal is to nudge the LLM to reason about
 * temporal density, not to enumerate every pair.
 */
export function detectTemporalClusters(
  timeline: TimelineEvent[],
): TemporalCluster[] {
  if (timeline.length === 0) return [];

  const clusters: TemporalCluster[] = [];

  // ----- Same-day clusters -----
  const byDay = new Map<string, TimelineEvent[]>();
  for (const ev of timeline) {
    const day = ev.at.slice(0, 10); // YYYY-MM-DD
    const bucket = byDay.get(day) ?? [];
    bucket.push(ev);
    byDay.set(day, bucket);
  }

  const coveredDayKeys = new Set<string>();
  for (const [day, bucket] of byDay) {
    if (bucket.length < SAME_DAY_CLUSTER_THRESHOLD) continue;
    coveredDayKeys.add(day);
    const sorted = [...bucket].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at),
    );
    clusters.push({
      window: "same_day",
      start: sorted[0].at,
      end: sorted[sorted.length - 1].at,
      event_count: bucket.length,
      categories: uniqueCategories(bucket),
      summary: `${bucket.length} events on ${day}`,
    });
  }

  // ----- Same-week (rolling 7-day) clusters -----
  // Walk the timeline and, for each event, count how many subsequent
  // events fall within 7 days. We record the first window that meets
  // the threshold and then skip past it so we don't report the same
  // burst multiple times.
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  let i = 0;
  while (i < timeline.length) {
    let j = i;
    while (
      j < timeline.length &&
      Date.parse(timeline[j].at) - Date.parse(timeline[i].at) <= WEEK_MS
    ) {
      j++;
    }
    const windowSlice = timeline.slice(i, j);
    if (windowSlice.length >= SAME_WEEK_CLUSTER_THRESHOLD) {
      // Skip if every event in this window is already inside a
      // same-day cluster — no new information to add.
      const allInSameDay = windowSlice.every((e) =>
        coveredDayKeys.has(e.at.slice(0, 10)),
      );
      if (!allInSameDay) {
        clusters.push({
          window: "same_week",
          start: windowSlice[0].at,
          end: windowSlice[windowSlice.length - 1].at,
          event_count: windowSlice.length,
          categories: uniqueCategories(windowSlice),
          summary: `${windowSlice.length} events in a 7-day window`,
        });
      }
      i = j; // advance past this window
    } else {
      i++;
    }
  }

  return clusters;
}

function uniqueCategories(
  events: TimelineEvent[],
): TimelineEvent["category"][] {
  const seen = new Set<TimelineEvent["category"]>();
  const ordered: TimelineEvent["category"][] = [];
  for (const e of events) {
    if (!seen.has(e.category)) {
      seen.add(e.category);
      ordered.push(e.category);
    }
  }
  return ordered;
}

/**
 * Input shape for `detectGaps`. These are the minimum fields needed to
 * reason about "what's missing" without hitting the DB again.
 */
export interface GapDetectionInputs {
  active_diagnoses_count: number;
  latest_vital_at: string | null;
  latest_note_at: string | null;
}

/**
 * Deterministic care-gap pre-pass. Currently covers:
 *
 *  1. Stale vitals — no vital recorded in ≥ STALE_VITALS_DAYS days
 *     (warning). Patients on an inpatient floor or with active
 *     diagnoses should have vitals more often than that.
 *  2. Stale note — no clinical note in ≥ STALE_NOTE_DAYS days despite
 *     having active diagnoses (info — long intervals are common in
 *     stable outpatient care, but worth flagging).
 *
 * Gap rules are intentionally conservative — false positives waste LLM
 * attention and dilute real findings.
 */
export function detectGaps(
  inputs: GapDetectionInputs,
  nowIso: string = new Date().toISOString(),
): GapDetected[] {
  const now = Date.parse(nowIso);
  const gaps: GapDetected[] = [];

  const daysSince = (iso: string): number =>
    Math.floor((now - Date.parse(iso)) / (24 * 60 * 60 * 1000));

  if (inputs.latest_vital_at) {
    const days = daysSince(inputs.latest_vital_at);
    if (days >= STALE_VITALS_DAYS) {
      gaps.push({
        description: `No vitals recorded in ${days} days`,
        since: inputs.latest_vital_at,
        severity: "warning",
      });
    }
  } else if (inputs.active_diagnoses_count > 0) {
    // Patient has active problems but no vitals on record at all.
    gaps.push({
      description: "No vitals on record despite active diagnoses",
      since: nowIso,
      severity: "warning",
    });
  }

  if (inputs.active_diagnoses_count > 0 && inputs.latest_note_at) {
    const days = daysSince(inputs.latest_note_at);
    if (days >= STALE_NOTE_DAYS) {
      gaps.push({
        description: `No clinical note in ${days} days (active problem list)`,
        since: inputs.latest_note_at,
        severity: "info",
      });
    }
  }

  return gaps;
}
