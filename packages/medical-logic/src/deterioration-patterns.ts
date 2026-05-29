/**
 * Deterioration trajectory pattern detectors.
 *
 * Pure functions that operate on a snapshot of longitudinal patient data
 * and return a structured PatternResult describing whether the pattern
 * fired and what evidence supported it. No DB I/O, no LLM calls, fully
 * testable against synthetic timelines.
 *
 * These detectors are the building blocks of the DETERIORATION-TRAJECTORY-001
 * umbrella rule (see services/ai-oversight/src/rules/deterioration-trajectory.ts).
 * See MISSION.md for the founding context.
 *
 * Status (2026-05-28): scaffolding milestone. The first three detectors
 * (READMISSION-TRAJECTORY, DISCHARGE-READINESS, CROSS-SPECIALTY-SYMPTOM-ORPHAN)
 * ship with initial heuristics tuned to the founding case class. Clinical
 * threshold calibration is pending clinician review per LAUNCH-CHECKLIST.md.
 *
 * The remaining three patterns in the family (WARNING-SIGN-AGGREGATOR,
 * COPY-FORWARD-DRIFT, CONSULT-LOOP-OPEN) are stubbed as future work and
 * tracked in MISSION.md § "First rule: DETERIORATION-TRAJECTORY-001".
 */

// ─── Shared types ───────────────────────────────────────────────

/**
 * A prior hospital encounter (admission). Used by detectors that need to
 * trend signals across admissions to surface readmission patterns.
 */
export interface PriorEncounter {
  encounter_id: string;
  /** ISO 8601 admission timestamp. */
  admitted_at: string;
  /** ISO 8601 discharge timestamp; absent if encounter is still open. */
  discharged_at?: string;
  /** Chief complaint at admission; null if not recorded. */
  chief_complaint: string | null;
  /** Discharge diagnoses (free-text descriptions). */
  discharge_diagnoses?: string[];
  /** Active medications at discharge. */
  discharge_medications?: string[];
  /**
   * Selected lab values at discharge, for cross-admission trend comparison.
   * Detectors use these to compare admission-N's discharge against
   * admission-N+1's admission baseline.
   */
  discharge_labs?: Array<{ name: string; value: number; unit: string }>;
}

/**
 * The current (open) encounter. Used as the "now" anchor for trajectory
 * comparisons and length-of-stay calculations.
 */
export interface CurrentEncounter {
  encounter_id: string;
  /** ISO 8601 admission timestamp for this encounter. */
  admitted_at: string;
  /** Computed length-of-stay in hours so far; orchestrator-derived. */
  length_of_stay_hours?: number;
  /** Attending specialty (e.g. "hospitalist", "oncology"). */
  attending_specialty?: string;
  /** Specialties consulting on this encounter. */
  consulting_specialties?: string[];
  /**
   * Planned discharge timestamp if one has been entered (e.g. by the
   * discharge planner or attending). Absent if no discharge plan is set.
   */
  planned_discharge_at?: string;
}

/**
 * A consult request placed during the current encounter. Used by
 * DISCHARGE-READINESS to detect open-loop consults at discharge time and
 * (future) by CONSULT-LOOP-OPEN as a standalone signal.
 */
export interface ConsultRequest {
  consult_id: string;
  /** ISO 8601 timestamp when the consult was requested. */
  requested_at: string;
  /** Specialty being consulted. */
  specialty: string;
  /** ISO 8601 timestamp when a closing note was linked, if any. */
  responded_at?: string;
  /** Note id that closed the consult, if any. */
  closed_by_note_id?: string;
}

/**
 * Time-series of a lab analyte across one or more encounters. Each value
 * carries its encounter_id so detectors can bucket measurements by
 * admission for cross-admission trend analysis.
 */
export interface LabTrend {
  lab_name: string;
  values: Array<{
    value: number;
    unit: string;
    /** ISO 8601 measurement timestamp. */
    measured_at: string;
    encounter_id: string;
  }>;
}

/**
 * Time-series of a vital sign across one or more encounters. Same
 * bucketing-by-encounter pattern as LabTrend.
 */
export interface VitalTrend {
  vital_type:
    | "blood_pressure_systolic"
    | "blood_pressure_diastolic"
    | "heart_rate"
    | "respiratory_rate"
    | "temperature"
    | "o2_sat";
  values: Array<{
    value: number;
    /** ISO 8601 measurement timestamp. */
    measured_at: string;
    encounter_id: string;
  }>;
}

/**
 * Signal that discharge documentation/orders are being prepared for the
 * current encounter. Detected by the orchestrator from note-template
 * usage, discharge-order placement, or manual flagging.
 */
export interface DischargeSignal {
  is_discharge_imminent: boolean;
  detected_at: string;
  source: "note_template" | "discharge_order" | "manual";
}

/**
 * A symptom observation extracted from a specific note. Used by
 * CROSS-SPECIALTY-SYMPTOM-ORPHAN to detect symptoms mentioned across
 * multiple specialty notes without any specialty owning the workup.
 */
export interface SymptomObservation {
  /** Normalized symptom name (lowercase, singular). */
  symptom: string;
  /** Specialty of the documenting clinician. */
  documented_by_specialty: string;
  /** ISO 8601 timestamp of the documenting note. */
  documented_at: string;
  /**
   * True if the documenting note (or any subsequent note) shows an order,
   * plan, or follow-up referencing this symptom — i.e. a specialty has
   * "owned" the workup.
   */
  has_workup: boolean;
}

/**
 * The standard return shape for every detector. `fired` is the canonical
 * boolean for "this pattern matched and a flag should be considered."
 * `details` carries machine-readable evidence for downstream consumers
 * (the umbrella rule's metadata, the flag rationale builder, telemetry).
 */
export interface PatternResult {
  fired: boolean;
  /** Machine-readable evidence. Shape is detector-specific. */
  details?: Record<string, unknown>;
  /** Human-readable one-line summary of why the pattern fired. */
  summary?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

function parseIso(ts: string | undefined | null): number | null {
  if (!ts) return null;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : null;
}

function daysBetween(earlierIso: string, laterIso: string): number | null {
  const a = parseIso(earlierIso);
  const b = parseIso(laterIso);
  if (a === null || b === null) return null;
  return (b - a) / 86_400_000;
}

/**
 * Compare the most recent value of a lab series within encounter A
 * against the most recent within encounter B. Returns the delta if both
 * are present in the same unit; null otherwise. Used by readmission
 * trajectory detection — the unit-match guard fails closed on unit drift.
 */
function compareLabAcrossEncounters(
  trend: LabTrend,
  encounterIdA: string,
  encounterIdB: string,
): { from: number; to: number; unit: string; delta: number } | null {
  const inA = trend.values
    .filter((v) => v.encounter_id === encounterIdA)
    .sort((x, y) => parseIso(x.measured_at)! - parseIso(y.measured_at)!);
  const inB = trend.values
    .filter((v) => v.encounter_id === encounterIdB)
    .sort((x, y) => parseIso(x.measured_at)! - parseIso(y.measured_at)!);
  const lastA = inA[inA.length - 1];
  const lastB = inB[inB.length - 1];
  if (!lastA || !lastB) return null;
  if (lastA.unit !== lastB.unit) return null; // fail closed on unit drift
  return {
    from: lastA.value,
    to: lastB.value,
    unit: lastA.unit,
    delta: lastB.value - lastA.value,
  };
}

/**
 * Direction of "concerning" for common labs. Used by readmission trend
 * detection to interpret a delta as a worsening (vs improving) trajectory.
 * Conservative subset for the scaffolding milestone; expand as clinical
 * review nominates additional analytes.
 */
const LAB_CONCERN_DIRECTION: Record<string, "rising" | "falling"> = {
  creatinine: "rising",
  bun: "rising",
  troponin: "rising",
  lactate: "rising",
  bnp: "rising",
  "nt-probnp": "rising",
  wbc: "rising",
  crp: "rising",
  procalcitonin: "rising",
  hemoglobin: "falling",
  hgb: "falling",
  hematocrit: "falling",
  hct: "falling",
  platelets: "falling",
  plt: "falling",
  albumin: "falling",
  sodium: "falling",
};

function isWorsening(labName: string, delta: number): boolean {
  const dir = LAB_CONCERN_DIRECTION[labName.toLowerCase()];
  if (!dir) return false;
  return dir === "rising" ? delta > 0 : delta < 0;
}

// ─── Detector 1: READMISSION-TRAJECTORY ───────────────────────────

/**
 * Detect a readmission trajectory: the patient has been admitted within
 * the lookback window and the labs/vitals trended in the concerning
 * direction across admissions.
 *
 * Fires when:
 *   - at least one prior encounter exists in the lookback window AND
 *   - any tracked lab (creatinine, hemoglobin, lactate, etc.) shows a
 *     worsening trend from prior discharge → current admission baseline.
 *
 * Returns null result if no prior encounters in window or no lab/vital
 * data to evaluate (fail closed).
 */
export function detectReadmissionTrajectory(opts: {
  prior_encounters: PriorEncounter[];
  current_encounter: CurrentEncounter;
  lab_trends?: LabTrend[];
  vital_trends?: VitalTrend[];
  /** Default 90 days. */
  lookback_days?: number;
}): PatternResult {
  const lookback = opts.lookback_days ?? 90;
  const currentAdmittedAt = parseIso(opts.current_encounter.admitted_at);
  if (currentAdmittedAt === null) return { fired: false };

  const inWindow = opts.prior_encounters.filter((p) => {
    const days = daysBetween(p.admitted_at, opts.current_encounter.admitted_at);
    return days !== null && days >= 0 && days <= lookback;
  });
  if (inWindow.length === 0) return { fired: false };

  // Most recent prior encounter — closest in time to the current admission.
  inWindow.sort(
    (a, b) => parseIso(b.admitted_at)! - parseIso(a.admitted_at)!,
  );
  const mostRecentPrior = inWindow[0];

  const worseningLabs: Array<{
    name: string;
    from: number;
    to: number;
    unit: string;
    delta: number;
  }> = [];

  for (const trend of opts.lab_trends ?? []) {
    const cmp = compareLabAcrossEncounters(
      trend,
      mostRecentPrior.encounter_id,
      opts.current_encounter.encounter_id,
    );
    if (cmp && isWorsening(trend.lab_name, cmp.delta)) {
      worseningLabs.push({ name: trend.lab_name, ...cmp });
    }
  }

  if (worseningLabs.length === 0) {
    return {
      fired: false,
      details: {
        admissions_in_window: inWindow.length,
        lookback_days: lookback,
      },
    };
  }

  return {
    fired: true,
    summary:
      `Admission ${inWindow.length + 1} in ${lookback}d window. ` +
      `Worsening trend across admissions: ` +
      worseningLabs
        .slice(0, 3)
        .map(
          (l) =>
            `${l.name} ${l.from}→${l.to} ${l.unit}`,
        )
        .join(", "),
    details: {
      admissions_in_window: inWindow.length,
      lookback_days: lookback,
      most_recent_prior_encounter_id: mostRecentPrior.encounter_id,
      worsening_labs: worseningLabs,
    },
  };
}

// ─── Detector 2: DISCHARGE-READINESS ──────────────────────────────

/**
 * Detect a discharge decision being made while signals suggest the
 * patient is not ready: trending-wrong labs, open consults, unresolved
 * symptoms.
 *
 * Fires when the discharge signal indicates discharge is imminent AND
 * at least one of:
 *   - any tracked lab is still trending in the worsening direction
 *     within the current encounter, OR
 *   - a consult requested ≥24h ago has no closing note, OR
 *   - recent symptoms are non-empty (the orchestrator should pass only
 *     unresolved symptoms here).
 */
export function detectDischargeReadinessRisk(opts: {
  discharge_signal: DischargeSignal;
  consult_requests?: ConsultRequest[];
  lab_trends?: LabTrend[];
  recent_symptoms?: string[];
  current_encounter_id?: string;
  /** Hours an unanswered consult must be open to count. Default 24. */
  open_consult_hours?: number;
}): PatternResult {
  if (!opts.discharge_signal.is_discharge_imminent) return { fired: false };

  const reasons: string[] = [];
  const details: Record<string, unknown> = {};

  // Worsening labs within the current encounter
  const worseningInCurrent: Array<{ name: string; values: number[]; unit: string }> = [];
  for (const trend of opts.lab_trends ?? []) {
    const inCurrent = opts.current_encounter_id
      ? trend.values
          .filter((v) => v.encounter_id === opts.current_encounter_id)
          .sort((a, b) => parseIso(a.measured_at)! - parseIso(b.measured_at)!)
      : trend.values
          .slice()
          .sort((a, b) => parseIso(a.measured_at)! - parseIso(b.measured_at)!);
    if (inCurrent.length < 2) continue;
    const first = inCurrent[0];
    const last = inCurrent[inCurrent.length - 1];
    if (first.unit !== last.unit) continue;
    const delta = last.value - first.value;
    if (!isWorsening(trend.lab_name, delta)) continue;
    worseningInCurrent.push({
      name: trend.lab_name,
      values: inCurrent.map((v) => v.value),
      unit: first.unit,
    });
  }
  if (worseningInCurrent.length > 0) {
    reasons.push(
      `labs trending wrong: ${worseningInCurrent
        .slice(0, 3)
        .map((l) => `${l.name}`)
        .join(", ")}`,
    );
    details.worsening_labs_in_current = worseningInCurrent;
  }

  // Open consults
  const openConsultHours = opts.open_consult_hours ?? 24;
  const dischargeDetectedAt = parseIso(opts.discharge_signal.detected_at);
  const openConsults = (opts.consult_requests ?? []).filter((c) => {
    if (c.responded_at) return false;
    const requestedAt = parseIso(c.requested_at);
    if (requestedAt === null || dischargeDetectedAt === null) return false;
    const ageHours = (dischargeDetectedAt - requestedAt) / 3_600_000;
    return ageHours >= openConsultHours;
  });
  if (openConsults.length > 0) {
    reasons.push(
      `${openConsults.length} open consult${openConsults.length === 1 ? "" : "s"} (${openConsults
        .map((c) => c.specialty)
        .join(", ")})`,
    );
    details.open_consults = openConsults;
  }

  // Unresolved symptoms (caller is responsible for filtering)
  if (opts.recent_symptoms && opts.recent_symptoms.length > 0) {
    reasons.push(
      `unresolved symptoms: ${opts.recent_symptoms.slice(0, 3).join(", ")}`,
    );
    details.unresolved_symptoms = opts.recent_symptoms;
  }

  if (reasons.length === 0) return { fired: false };

  return {
    fired: true,
    summary: `Discharge imminent with: ${reasons.join("; ")}.`,
    details,
  };
}

// ─── Detector 3: CROSS-SPECIALTY-SYMPTOM-ORPHAN ────────────────────

/**
 * Detect a symptom documented across multiple specialty notes with no
 * specialty owning the workup. Catches the "everyone noted it, nobody
 * addressed it" pattern that is invisible to single-note review.
 *
 * Fires when any single symptom is documented by ≥`min_specialties`
 * distinct specialties (default 2) AND none of those observations show
 * a workup.
 */
export function detectCrossSpecialtySymptomOrphan(opts: {
  symptom_observations: SymptomObservation[];
  /** Default 2 — minimum distinct specialties to count as cross-specialty. */
  min_specialties?: number;
}): PatternResult {
  const minSpecialties = opts.min_specialties ?? 2;
  const bySymptom = new Map<string, SymptomObservation[]>();
  for (const obs of opts.symptom_observations) {
    const key = obs.symptom.toLowerCase().trim();
    const arr = bySymptom.get(key) ?? [];
    arr.push(obs);
    bySymptom.set(key, arr);
  }

  const orphaned: Array<{
    symptom: string;
    specialties: string[];
    observation_count: number;
  }> = [];

  for (const [symptom, obsArr] of bySymptom.entries()) {
    const specialties = Array.from(
      new Set(obsArr.map((o) => o.documented_by_specialty.toLowerCase())),
    );
    if (specialties.length < minSpecialties) continue;
    const anyWorkup = obsArr.some((o) => o.has_workup);
    if (anyWorkup) continue;
    orphaned.push({
      symptom,
      specialties,
      observation_count: obsArr.length,
    });
  }

  if (orphaned.length === 0) return { fired: false };

  return {
    fired: true,
    summary:
      `Symptom${orphaned.length === 1 ? "" : "s"} documented across multiple specialties without ownership: ` +
      orphaned
        .slice(0, 3)
        .map(
          (o) =>
            `${o.symptom} (${o.specialties.join(", ")})`,
        )
        .join("; "),
    details: { orphaned_symptoms: orphaned },
  };
}

// ─── Future stubs ─────────────────────────────────────────────────

/**
 * WARNING-SIGN-AGGREGATOR: composite criteria like SIRS / qSOFA / MEWS
 * over individually-soft vitals + labs + temp. Future.
 */
export function detectWarningSignAggregator(_opts: {
  recent_vitals: VitalTrend[];
  recent_labs?: Array<{ name: string; value: number; unit: string }>;
}): PatternResult {
  return { fired: false }; // not yet implemented
}

/**
 * COPY-FORWARD-DRIFT: note text > 80% text-similar to prior shift's
 * note where at least one clinical signal has changed since. Future.
 */
export function detectCopyForwardDrift(_opts: {
  current_note_text: string;
  prior_note_text: string;
  clinical_changes_since: number;
}): PatternResult {
  return { fired: false }; // not yet implemented
}

/**
 * CONSULT-LOOP-OPEN: standalone version of the consult-loop check from
 * DISCHARGE-READINESS — fires at shift change rather than discharge.
 * Future.
 */
export function detectConsultLoopOpen(_opts: {
  consult_requests: ConsultRequest[];
  open_consult_hours?: number;
}): PatternResult {
  return { fired: false }; // not yet implemented
}
