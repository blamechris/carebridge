/**
 * Phase A2: contradiction and gap detection rules that operate on
 * structured note assertions.
 *
 * These rules consume the NoteAssertionsPayload produced by the Phase A1
 * note-extractor (services/ai-oversight/src/extractors/note-extractor.ts)
 * and cross-reference it against recent structured data (vitals, labs,
 * prior notes, active meds) to surface the kinds of inconsistencies a
 * single specialist working in isolation can miss.
 *
 * These are deterministic rules — no LLM, no network. The LLM review
 * path runs separately in review-service.ts and catches patterns rules
 * cannot express. This layer is the fast, cheap, predictable first pass.
 *
 * Rules implemented:
 *   NOTE-VITAL-CONTRADICTION-001  — note denies a symptom whose
 *     corresponding objective vital value contradicts the denial
 *     (e.g., "denies dyspnea" + SpO2 < 90%).
 *   NOTE-NOTE-CONTRADICTION-001   — two recent notes from different
 *     providers assert contradictory facts about the same symptom.
 *   PLAN-FOLLOWUP-GAP-001         — a plan item's target follow-up date
 *     has passed with no subsequent note referencing the action.
 *   STALE-EVIDENCE-001            — note cites a referenced result whose
 *     asserted_date is more than STALE_EVIDENCE_DAYS old.
 *   ORDERED-NOT-RESULTED-001      — plan item orders a test; no matching
 *     panel/procedure exists within the expected window.
 *   MEDICATION-ASSERTION-MISMATCH-001 — note asserts the patient is "on"
 *     a high-risk medication that isn't in the active medication list.
 *
 * Design notes:
 *   - Pure functions. All DB access happens in the caller
 *     (review-service.ts) and is passed in as NoteCorrelationContext.
 *     Tests can stub the context directly with no DB mocking.
 *   - Every flag carries the evidence_quote from the source assertion
 *     so the clinician can see exactly which sentence triggered it.
 *   - Category choice: contradictions and stale evidence are
 *     "documentation-discrepancy"; missing follow-ups / orders are
 *     "care-gap"; medication mismatch is "medication-safety".
 */

import type { FlagSeverity, FlagCategory } from "@carebridge/shared-types";
import type { NoteAssertionsPayload } from "@carebridge/shared-types";
import type { RuleFlag } from "./critical-values.js";

// ─── Context types ───────────────────────────────────────────────

/**
 * The note that just got extracted — the subject of correlation.
 */
export interface CurrentNoteForCorrelation {
  id: string;
  patient_id: string;
  provider_id: string;
  /** Resolved from the users table. Null when unknown. */
  provider_specialty: string | null;
  /** ISO-8601 timestamp the note was signed. */
  signed_at: string;
  payload: NoteAssertionsPayload;
}

/** A prior signed note with its extracted assertions. */
export interface PriorNoteForCorrelation {
  id: string;
  provider_id: string;
  provider_specialty: string | null;
  signed_at: string;
  payload: NoteAssertionsPayload;
}

/**
 * Recent vital signs for contradiction checks. Ordered by recorded_at
 * descending; the caller decides the window (default 24h around signing).
 */
export interface RecentVitalForCorrelation {
  type: string;
  value_primary: number;
  value_secondary: number | null;
  unit: string;
  recorded_at: string;
}

/** Lab panel record for the ORDERED-NOT-RESULTED-001 rule. */
export interface RecentPanelForCorrelation {
  panel_name: string;
  ordered_at: string | null;
  reported_at: string | null;
  created_at: string;
}

/** Pure inputs to the note-correlation rule pass. */
export interface NoteCorrelationContext {
  current_note: CurrentNoteForCorrelation;
  /**
   * Other notes signed in a configurable lookback window around the
   * current note. Exclude the current note itself. The caller is
   * responsible for the window (default 7 days).
   */
  prior_notes: PriorNoteForCorrelation[];
  /** Vitals recorded within ±24h of current_note.signed_at. */
  recent_vitals: RecentVitalForCorrelation[];
  /** Lab panels created within 14 days after current_note.signed_at. */
  subsequent_panels: RecentPanelForCorrelation[];
  /** Active medications for the patient (already filtered to status = active). */
  active_medication_names: string[];
  /**
   * Evaluation reference time. Explicit rather than Date.now() so rule
   * tests are deterministic. Defaults to the current note's signed_at
   * in review-service but tests pass a fixed clock.
   */
  now: Date;
}

// ─── Shared constants ────────────────────────────────────────────

/**
 * How many days old a referenced result can be before it's considered
 * stale when cited as "current" evidence. 180 days is a defensible
 * threshold for imaging and labs that inform longitudinal decisions
 * (e.g., an echo cited as "recent" should be within 6 months).
 */
const STALE_EVIDENCE_DAYS = 180;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Maps a denied symptom pattern to an objective contradiction.
 * Units match the CareBridge internal vital representation:
 *   temperature in °F, O2 in %, BP in mmHg, HR in bpm, RR in breaths/min.
 *
 * Thresholds are intentionally conservative — enough to be clearly
 * contradictory, not borderline. Tight thresholds prevent alert fatigue
 * while still catching the "denied X but objective Y says otherwise"
 * pattern that motivates this rule.
 */
interface VitalContradictionProbe {
  symptom_pattern: RegExp;
  vital_type: string;
  /** Return true if the vital value contradicts the denial. */
  contradicts: (value: number, secondary: number | null) => boolean;
  /** Human-readable contradiction description for the flag rationale. */
  describe: (value: number, secondary: number | null, unit: string) => string;
}

const VITAL_CONTRADICTION_PROBES: VitalContradictionProbe[] = [
  {
    symptom_pattern: /\b(dyspnea|shortness of breath|sob|difficulty breathing|breathlessness)\b/i,
    vital_type: "o2_sat",
    contradicts: (v) => v < 90,
    describe: (v, _s, u) => `SpO2 ${v}${u} is hypoxic`,
  },
  {
    symptom_pattern: /\b(dyspnea|shortness of breath|sob|tachypnea)\b/i,
    vital_type: "respiratory_rate",
    contradicts: (v) => v > 24,
    describe: (v, _s, u) => `respiratory rate ${v} ${u} is tachypneic`,
  },
  {
    symptom_pattern: /\b(fever|febrile|chills|pyrexia)\b/i,
    vital_type: "temperature",
    // CareBridge stores temperature in °F. 100.4°F = 38°C = fever.
    contradicts: (v) => v >= 100.4,
    describe: (v, _s, u) => `temperature ${v}${u} meets the fever threshold`,
  },
  {
    symptom_pattern: /\btachycardia\b/i,
    vital_type: "heart_rate",
    contradicts: (v) => v > 110,
    describe: (v, _s, u) => `heart rate ${v} ${u} is tachycardic`,
  },
  {
    symptom_pattern: /\b(hypertension|high blood pressure|htn)\b/i,
    vital_type: "blood_pressure",
    // value_primary is systolic; value_secondary is diastolic.
    contradicts: (systolic, diastolic) =>
      systolic >= 160 || (diastolic !== null && diastolic >= 100),
    describe: (systolic, diastolic, u) =>
      `blood pressure ${systolic}/${diastolic ?? "?"} ${u} is hypertensive`,
  },
  {
    symptom_pattern: /\b(hypoxia|low oxygen|desaturation|desat)\b/i,
    vital_type: "o2_sat",
    contradicts: (v) => v < 92,
    describe: (v, _s, u) => `SpO2 ${v}${u} is below 92%`,
  },
];

/**
 * High-risk medication patterns where an assertion mismatch is
 * clinically dangerous. Narrow list on purpose — this rule must not
 * fire for every over-the-counter med the note mentions.
 */
const HIGH_RISK_MED_PROBES: Array<{
  name: string;
  pattern: RegExp;
  rationale: string;
}> = [
  {
    name: "warfarin",
    pattern: /\b(warfarin|coumadin)\b/i,
    rationale:
      "Note references warfarin, which is not in the active medication list. " +
      "If the patient has actually stopped warfarin, thrombotic risk needs reassessment. " +
      "If the note is wrong, the plan based on it is wrong.",
  },
  {
    name: "anticoagulant (DOAC)",
    pattern: /\b(apixaban|eliquis|rivaroxaban|xarelto|dabigatran|pradaxa|edoxaban|savaysa)\b/i,
    rationale:
      "Note references a direct oral anticoagulant not in the active medication list. " +
      "Verify whether the drug was discontinued and the note is stale, or the medication list is incomplete.",
  },
  {
    name: "heparin",
    pattern: /\b(heparin|enoxaparin|lovenox|fondaparinux|arixtra)\b/i,
    rationale:
      "Note references parenteral anticoagulant therapy not in the active medication list.",
  },
  {
    name: "insulin",
    pattern: /\binsulin\b/i,
    rationale:
      "Note references insulin, but no active insulin order exists. Mismatched insulin orders are a leading " +
      "source of inpatient hypoglycemia and hyperglycemic crisis.",
  },
  {
    name: "chemotherapy",
    pattern: /\b(cisplatin|carboplatin|doxorubicin|cyclophosphamide|paclitaxel|docetaxel|methotrexate|5-fu|fluorouracil|capecitabine|xeloda)\b/i,
    rationale:
      "Note references chemotherapy not in the active medication list. Chemo cycles have precise scheduling " +
      "and dose-limiting toxicities — stale or missing records are a serious documentation error.",
  },
  {
    name: "beta-blocker",
    pattern: /\b(metoprolol|atenolol|carvedilol|bisoprolol|propranolol)\b/i,
    rationale:
      "Note references a beta-blocker not in the active medication list.",
  },
];

/**
 * Regex that identifies an action verb meaning the note is ORDERING
 * something to be done, not referencing something already done.
 */
const ORDER_VERB_PATTERN =
  /\b(order|obtain|draw|check|repeat|schedule|get|perform)\b/i;

/** Patterns that identify the kind of test a plan item is ordering. */
const ORDER_TEST_PATTERNS: Array<{ kind: string; pattern: RegExp }> = [
  { kind: "cbc", pattern: /\b(cbc|complete blood count)\b/i },
  { kind: "bmp", pattern: /\b(bmp|basic metabolic|chem ?7)\b/i },
  { kind: "cmp", pattern: /\b(cmp|comprehensive metabolic|chem ?14)\b/i },
  { kind: "troponin", pattern: /\btroponin\b/i },
  { kind: "bnp", pattern: /\b(bnp|nt-probnp|pro-bnp)\b/i },
  { kind: "d-dimer", pattern: /\bd-?dimer\b/i },
  { kind: "inr", pattern: /\b(inr|pt\/inr|pt-inr)\b/i },
  { kind: "ct", pattern: /\b(ct scan|ct chest|ct head|ct abdomen|ct angio|cta)\b/i },
  { kind: "mri", pattern: /\b(mri|mra)\b/i },
  { kind: "echo", pattern: /\b(echo|echocardiogram|tte|tee)\b/i },
  { kind: "x-ray", pattern: /\b(x-ray|xray|cxr|chest x-?ray|radiograph)\b/i },
];

// ─── Helpers ─────────────────────────────────────────────────────

/**
 * Parse an ISO-8601 or YYYY-MM-DD date string. Returns null for
 * anything else (the extractor is told to leave relative dates
 * verbatim, so "in 2 weeks" → null → those plan items are skipped by
 * the follow-up rule rather than firing a false positive).
 */
function parseAbsoluteDate(raw: string | null): Date | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // Require a leading YYYY-MM-DD so we don't accept "2 weeks" or "day 3".
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / MS_PER_DAY;
}

function truncateQuote(quote: string | null, max = 160): string {
  if (!quote) return "";
  return quote.length > max ? `${quote.slice(0, max)}...` : quote;
}

// ─── NOTE-VITAL-CONTRADICTION-001 ────────────────────────────────

function checkNoteVitalContradiction(
  ctx: NoteCorrelationContext,
): RuleFlag[] {
  const flags: RuleFlag[] = [];
  const denied = ctx.current_note.payload.symptoms_denied;
  if (denied.length === 0 || ctx.recent_vitals.length === 0) return flags;

  // Deduplicate: one flag per (denied symptom, vital type) pair, not
  // one per matching probe, so two probes hitting the same O2 sat value
  // don't produce duplicate flags.
  const seen = new Set<string>();

  for (const deniedSymptom of denied) {
    for (const probe of VITAL_CONTRADICTION_PROBES) {
      if (!probe.symptom_pattern.test(deniedSymptom)) continue;

      // Find the most recent vital of this type that contradicts.
      const contradictingVital = ctx.recent_vitals.find(
        (v) =>
          v.type === probe.vital_type &&
          probe.contradicts(v.value_primary, v.value_secondary),
      );
      if (!contradictingVital) continue;

      const key = `${deniedSymptom.toLowerCase()}::${probe.vital_type}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const description = probe.describe(
        contradictingVital.value_primary,
        contradictingVital.value_secondary,
        contradictingVital.unit,
      );

      flags.push({
        severity: "warning",
        category: "documentation-discrepancy",
        summary: `Note denies "${deniedSymptom}" but objective ${probe.vital_type.replace(/_/g, " ")} contradicts`,
        rationale:
          `The signed note states the patient denies "${deniedSymptom}", ` +
          `but a vital sign recorded near the time of signing shows ${description}. ` +
          `Reconcile the subjective denial with the objective measurement before ` +
          `acting on either.`,
        suggested_action:
          `Review the contradiction between the denied symptom and the objective vital. ` +
          `If the vital is correct, the note's subjective section likely needs amendment. ` +
          `If the denial is correct, reassess whether the vital was captured accurately.`,
        notify_specialties: [],
        rule_id: "NOTE-VITAL-CONTRADICTION-001",
      });
    }
  }

  return flags;
}

// ─── NOTE-NOTE-CONTRADICTION-001 ─────────────────────────────────

/**
 * Compare the current note's denied / reported symptoms with other
 * recent notes from different providers. When two notes disagree about
 * the same symptom, flag it.
 */
function checkNoteNoteContradiction(
  ctx: NoteCorrelationContext,
): RuleFlag[] {
  const flags: RuleFlag[] = [];
  if (ctx.prior_notes.length === 0) return flags;

  const current = ctx.current_note;
  const currentReported = new Map<string, string | null>(); // name → quote
  for (const s of current.payload.symptoms_reported) {
    currentReported.set(s.name.toLowerCase(), s.evidence_quote);
  }
  const currentDeniedSet = new Set(
    current.payload.symptoms_denied.map((s) => s.toLowerCase()),
  );

  // Track seen pairs so we don't duplicate the same contradiction
  // across multiple probes.
  const seen = new Set<string>();

  for (const prior of ctx.prior_notes) {
    if (prior.id === current.id) continue;
    if (prior.provider_id === current.provider_id) continue;

    const priorReported = new Map<string, string | null>();
    for (const s of prior.payload.symptoms_reported) {
      priorReported.set(s.name.toLowerCase(), s.evidence_quote);
    }
    const priorDeniedSet = new Set(
      prior.payload.symptoms_denied.map((s) => s.toLowerCase()),
    );

    // Direction 1: prior says reported, current denies.
    for (const [name, priorQuote] of priorReported) {
      if (!currentDeniedSet.has(name)) continue;
      const key = `${name}::${prior.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flags.push(
        buildNoteContradictionFlag({
          symptomName: name,
          priorSpecialty: prior.provider_specialty,
          priorSignedAt: prior.signed_at,
          priorClaim: "reports",
          currentClaim: "denies",
          priorQuote,
          currentQuote: null,
          currentSpecialty: current.provider_specialty,
        }),
      );
    }

    // Direction 2: prior says denied, current reports.
    for (const denied of priorDeniedSet) {
      if (!currentReported.has(denied)) continue;
      const key = `${denied}::${prior.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flags.push(
        buildNoteContradictionFlag({
          symptomName: denied,
          priorSpecialty: prior.provider_specialty,
          priorSignedAt: prior.signed_at,
          priorClaim: "denies",
          currentClaim: "reports",
          priorQuote: null,
          currentQuote: currentReported.get(denied) ?? null,
          currentSpecialty: current.provider_specialty,
        }),
      );
    }
  }

  return flags;
}

function buildNoteContradictionFlag(args: {
  symptomName: string;
  priorSpecialty: string | null;
  priorSignedAt: string;
  priorClaim: "reports" | "denies";
  currentClaim: "reports" | "denies";
  priorQuote: string | null;
  currentQuote: string | null;
  currentSpecialty: string | null;
}): RuleFlag {
  const priorLabel = args.priorSpecialty ?? "prior note";
  const currentLabel = args.currentSpecialty ?? "current note";
  const priorQuote = truncateQuote(args.priorQuote);
  const currentQuote = truncateQuote(args.currentQuote);
  const quoteSection = [
    priorQuote && `${priorLabel} (${args.priorSignedAt}): "${priorQuote}"`,
    currentQuote && `${currentLabel}: "${currentQuote}"`,
  ]
    .filter(Boolean)
    .join(" | ");

  return {
    severity: "warning",
    category: "documentation-discrepancy",
    summary: `Cross-specialty note disagreement about "${args.symptomName}"`,
    rationale:
      `The ${priorLabel} note signed ${args.priorSignedAt} ${args.priorClaim} ` +
      `"${args.symptomName}", but the ${currentLabel} note ${args.currentClaim} ` +
      `the same symptom. Cross-specialty documentation disagreement is a ` +
      `leading cause of missed diagnoses — confirm which is accurate.` +
      (quoteSection ? ` Evidence: ${quoteSection}` : ""),
    suggested_action:
      `Compare the two notes side-by-side. Speak with the patient directly to ` +
      `resolve the discrepancy. Amend whichever note is incorrect and document ` +
      `the clarification in the current encounter.`,
    notify_specialties: [args.priorSpecialty, args.currentSpecialty].filter(
      (s): s is string => Boolean(s),
    ),
    rule_id: "NOTE-NOTE-CONTRADICTION-001",
  };
}

// ─── PLAN-FOLLOWUP-GAP-001 ───────────────────────────────────────

/**
 * A plan item specified a follow-up by date X; date X is in the past,
 * and no subsequent note from the same patient mentions the action.
 *
 * This is intentionally conservative: only fires for plan items with
 * a resolvable ISO date, so relative dates ("in 2 weeks") never trip
 * it until the extractor is improved.
 */
function checkPlanFollowupGap(ctx: NoteCorrelationContext): RuleFlag[] {
  const flags: RuleFlag[] = [];
  const planItems = ctx.current_note.payload.plan_items;
  if (planItems.length === 0) return flags;

  for (const item of planItems) {
    const followupDate = parseAbsoluteDate(item.target_followup);
    if (!followupDate) continue;
    // Only fire if the target date is in the past relative to `now`.
    if (followupDate.getTime() >= ctx.now.getTime()) continue;

    // Check if any subsequent note mentions the action (by simple
    // substring match on action words). If any prior_note signed AFTER
    // the follow-up date mentions it, treat the gap as closed.
    const actionWords = extractSignificantWords(item.action);
    const addressed = ctx.prior_notes.some((note) => {
      if (new Date(note.signed_at).getTime() <= followupDate.getTime()) {
        return false;
      }
      const haystack = buildNoteHaystack(note.payload).toLowerCase();
      return actionWords.every((w) => haystack.includes(w));
    });
    if (addressed) continue;

    flags.push({
      severity: "warning",
      category: "care-gap",
      summary: `Follow-up overdue: "${item.action}" due ${item.target_followup ?? "unspecified"}`,
      rationale:
        `A plan item from the note signed ${ctx.current_note.signed_at} specified ` +
        `"${item.action}" with a target follow-up date of ${item.target_followup}. ` +
        `That date has passed and no subsequent note on this patient references ` +
        `the action. This pattern is how longitudinal care plans silently fall ` +
        `through the cracks between specialists.` +
        (item.evidence_quote ? ` Evidence: "${truncateQuote(item.evidence_quote)}"` : ""),
      suggested_action:
        `Confirm whether the follow-up occurred. If yes, document the result. ` +
        `If no, reschedule or escalate. Consider whether the care team owner ` +
        `(${item.ordered_by_specialty ?? "unspecified"}) should be notified.`,
      notify_specialties: item.ordered_by_specialty
        ? [item.ordered_by_specialty]
        : [],
      rule_id: "PLAN-FOLLOWUP-GAP-001",
    });
  }

  return flags;
}

/** Extract content words ≥4 chars from a free-text action string. */
function extractSignificantWords(text: string): string[] {
  const stopwords = new Set([
    "the",
    "and",
    "with",
    "for",
    "from",
    "this",
    "that",
    "into",
    "over",
    "under",
    "about",
    "then",
    "than",
    "order",
    "obtain",
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !stopwords.has(w));
}

/** Flatten a NoteAssertionsPayload into a searchable lowercase blob. */
function buildNoteHaystack(payload: NoteAssertionsPayload): string {
  const parts: string[] = [payload.one_line_summary];
  for (const s of payload.symptoms_reported) {
    parts.push(s.name);
    if (s.evidence_quote) parts.push(s.evidence_quote);
  }
  parts.push(...payload.symptoms_denied);
  for (const a of payload.assessments) {
    parts.push(a.problem);
    if (a.evidence_quote) parts.push(a.evidence_quote);
  }
  for (const p of payload.plan_items) {
    parts.push(p.action);
    if (p.evidence_quote) parts.push(p.evidence_quote);
  }
  for (const r of payload.referenced_results) {
    parts.push(r.type, r.value);
    if (r.evidence_quote) parts.push(r.evidence_quote);
  }
  return parts.join(" ");
}

// ─── STALE-EVIDENCE-001 ──────────────────────────────────────────

/**
 * If the note cites a referenced result whose asserted_date is more
 * than STALE_EVIDENCE_DAYS older than the note's signed_at, the note
 * is leaning on out-of-date evidence.
 */
function checkStaleEvidence(ctx: NoteCorrelationContext): RuleFlag[] {
  const flags: RuleFlag[] = [];
  const signedAt = new Date(ctx.current_note.signed_at);
  if (Number.isNaN(signedAt.getTime())) return flags;

  for (const result of ctx.current_note.payload.referenced_results) {
    const assertedDate = parseAbsoluteDate(result.asserted_date);
    if (!assertedDate) continue;
    const ageDays = daysBetween(signedAt, assertedDate);
    if (ageDays <= STALE_EVIDENCE_DAYS) continue;

    flags.push({
      severity: "warning",
      category: "documentation-discrepancy",
      summary: `Note cites stale evidence: ${result.type} from ${Math.round(ageDays)} days ago`,
      rationale:
        `The note cites a ${result.type} value of ${result.value} with an ` +
        `asserted date of ${result.asserted_date}, which is ${Math.round(ageDays)} ` +
        `days older than the note's signing time. Citing results more than ` +
        `${STALE_EVIDENCE_DAYS} days old as current evidence can lead to ` +
        `decisions based on outdated clinical state.` +
        (result.evidence_quote
          ? ` Evidence: "${truncateQuote(result.evidence_quote)}"`
          : ""),
      suggested_action:
        `Obtain an updated ${result.type} before making care decisions that ` +
        `rely on this value, or document why the old value is still clinically ` +
        `valid (e.g., "stable baseline, no interval change expected").`,
      notify_specialties: [],
      rule_id: "STALE-EVIDENCE-001",
    });
  }

  return flags;
}

// ─── ORDERED-NOT-RESULTED-001 ────────────────────────────────────

/**
 * A plan item uses order-verb language for a known test type, and no
 * matching panel or procedure appears in the follow-up window.
 */
function checkOrderedNotResulted(ctx: NoteCorrelationContext): RuleFlag[] {
  const flags: RuleFlag[] = [];
  const planItems = ctx.current_note.payload.plan_items;
  if (planItems.length === 0) return flags;

  const seen = new Set<string>();

  for (const item of planItems) {
    if (!ORDER_VERB_PATTERN.test(item.action)) continue;

    const matchedTest = ORDER_TEST_PATTERNS.find((p) => p.pattern.test(item.action));
    if (!matchedTest) continue;

    // De-dup by (test kind) so two plan items ordering the same test
    // don't each fire.
    if (seen.has(matchedTest.kind)) continue;
    seen.add(matchedTest.kind);

    // Search subsequent_panels for a match on kind. The caller filters
    // these to panels created within the expected window.
    const fulfilled = ctx.subsequent_panels.some((panel) =>
      matchedTest.pattern.test(panel.panel_name),
    );
    if (fulfilled) continue;

    flags.push({
      severity: "warning",
      category: "care-gap",
      summary: `Ordered but not resulted: ${matchedTest.kind}`,
      rationale:
        `The note plan ordered "${item.action}" (detected as ${matchedTest.kind}), ` +
        `but no matching panel or procedure has been recorded in the subsequent ` +
        `window. Tests that are ordered but never collected or resulted are a ` +
        `common source of missed diagnoses.` +
        (item.evidence_quote
          ? ` Evidence: "${truncateQuote(item.evidence_quote)}"`
          : ""),
      suggested_action:
        `Verify the ${matchedTest.kind} was placed in the order system and ` +
        `follow up on its status. If the order was never entered, enter it now ` +
        `and document the delay.`,
      notify_specialties: item.ordered_by_specialty
        ? [item.ordered_by_specialty]
        : [],
      rule_id: "ORDERED-NOT-RESULTED-001",
    });
  }

  return flags;
}

// ─── MEDICATION-ASSERTION-MISMATCH-001 ───────────────────────────

/**
 * The note asserts the patient is on a high-risk medication, but that
 * medication is not in the active medication list. Fires only for the
 * narrow HIGH_RISK_MED_PROBES set to keep signal-to-noise high.
 */
function checkMedicationAssertionMismatch(
  ctx: NoteCorrelationContext,
): RuleFlag[] {
  const flags: RuleFlag[] = [];
  const activeMeds = ctx.active_medication_names
    .map((m) => m.toLowerCase())
    .join(" ");

  // Build a text blob from assessments and plan items where the note
  // is most likely to claim a patient is "on" a drug.
  const probeTexts: Array<{ source: string; quote: string | null; text: string }> = [];
  for (const a of ctx.current_note.payload.assessments) {
    if (a.evidence_quote) {
      probeTexts.push({
        source: "assessment",
        quote: a.evidence_quote,
        text: `${a.problem} ${a.evidence_quote}`,
      });
    }
  }
  for (const p of ctx.current_note.payload.plan_items) {
    probeTexts.push({
      source: "plan",
      quote: p.evidence_quote,
      text: `${p.action} ${p.evidence_quote ?? ""}`,
    });
  }

  const seen = new Set<string>();

  for (const probe of HIGH_RISK_MED_PROBES) {
    for (const entry of probeTexts) {
      if (!probe.pattern.test(entry.text)) continue;
      // Only fire when the context suggests the note says the patient
      // is currently ON the medication, not that it was held / stopped.
      if (!/\b(on|taking|continues?|continuing|resumed?|maintained on|started)\b/i.test(entry.text)) {
        continue;
      }
      // If the medication is actually in the active list, no mismatch.
      if (probe.pattern.test(activeMeds)) continue;
      if (seen.has(probe.name)) continue;
      seen.add(probe.name);

      flags.push({
        severity: "warning",
        category: "medication-safety",
        summary: `Note asserts patient is on ${probe.name}, but it is not in the active medication list`,
        rationale:
          probe.rationale +
          (entry.quote ? ` Evidence: "${truncateQuote(entry.quote)}"` : ""),
        suggested_action:
          `Reconcile the medication list with the note. If the patient is taking ` +
          `${probe.name}, add it to the active medication list. If the patient ` +
          `has stopped, amend the note to reflect the current state.`,
        notify_specialties: [],
        rule_id: "MEDICATION-ASSERTION-MISMATCH-001",
      });
    }
  }

  return flags;
}

// ─── Orchestrator ────────────────────────────────────────────────

/**
 * Run every note-correlation rule against the given context.
 * Returns an aggregated RuleFlag[] the caller should feed into the
 * standard flag creation pipeline (createFlag, which handles dedup).
 */
export function checkNoteCorrelation(
  ctx: NoteCorrelationContext,
): RuleFlag[] {
  return [
    ...checkNoteVitalContradiction(ctx),
    ...checkNoteNoteContradiction(ctx),
    ...checkPlanFollowupGap(ctx),
    ...checkStaleEvidence(ctx),
    ...checkOrderedNotResulted(ctx),
    ...checkMedicationAssertionMismatch(ctx),
  ];
}

// Re-exports for tests that need to exercise individual rules.
export {
  checkNoteVitalContradiction,
  checkNoteNoteContradiction,
  checkPlanFollowupGap,
  checkStaleEvidence,
  checkOrderedNotResulted,
  checkMedicationAssertionMismatch,
};
