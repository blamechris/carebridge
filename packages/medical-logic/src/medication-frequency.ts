/**
 * Structured medication frequency parsing (issue #235).
 *
 * The medications table stores `frequency` as free-text. That's adequate
 * for display but useless for daily-cumulative-dose enforcement: "Q2H PRN"
 * as a string can't be compared against MEDICATION_MAX_DAILY_DOSES.
 *
 * This module parses the common clinical shorthand clinicians actually
 * write (q2h, bid, tid, qid, q4h, prn, daily, etc.) into a doses-per-24h
 * multiplier. The caller multiplies `dose_amount × dosesPerDay` to get an
 * implied daily-cumulative dose that can be checked against the per-drug
 * cap from `MEDICATION_MAX_DAILY_DOSES`.
 *
 * Unparseable strings return `null` so the calling rule can fail-open
 * (don't flag what we don't understand). High-risk drugs still get the
 * per-dose check from `validateMedicationDose`.
 */

/**
 * Canonical structured frequency values. Kept as a string union rather than
 * an enum so we can serialise/compare without runtime wrapping.
 */
export type MedFrequency =
  | "once" // one-time / stat — effectively not a daily drug
  | "daily" // qd, once a day
  | "bid" // twice daily
  | "tid" // three times daily
  | "qid" // four times daily
  | "q2h"
  | "q3h"
  | "q4h"
  | "q6h"
  | "q8h"
  | "q12h"
  | "weekly"
  | "monthly"
  | "prn"; // as-needed — no implicit daily count; caller must supply max_doses_per_day

/**
 * Doses-per-24h multiplier for each structured frequency. `prn` is zero
 * here — PRN prescriptions must carry an explicit `max_doses_per_day`
 * for daily-sum estimation; otherwise the rule cannot bound the dose.
 *
 * `once` maps to 0 — a stat order is not a recurring daily load, so
 * `estimateDailyDose` returns null for it (same semantics as an
 * unboundable PRN). Weekly/monthly are fractional so rules that
 * aggregate over shorter windows don't trigger false positives.
 */
export const FREQUENCY_DOSES_PER_DAY: Record<MedFrequency, number> = {
  once: 0, // stat / one-time — estimateDailyDose returns null
  daily: 1,
  bid: 2,
  tid: 3,
  qid: 4,
  q2h: 12,
  q3h: 8,
  q4h: 6,
  q6h: 4,
  q8h: 3,
  q12h: 2,
  weekly: 1 / 7,
  monthly: 1 / 30,
  prn: 0, // caller provides max_doses_per_day explicitly
};

/**
 * Parse a free-text frequency string into a {@link MedFrequency}.
 *
 * Handles: q2h / q 2 h / q2hr / q2hrs / every 2 hours / every 2h, bid, tid,
 * qid, qd / once daily / daily / once a day, weekly / q7d, monthly, stat /
 * once / one-time, prn / as needed.
 *
 * Intentionally lenient on whitespace and punctuation. Returns null for
 * strings it cannot classify — callers treat that as "unknown, don't flag".
 */
export function parseFrequencyText(
  text: string | null | undefined,
): MedFrequency | null {
  if (!text) return null;
  // Normalise: lowercase, collapse whitespace, drop punctuation that
  // shorthand forms commonly sprinkle in.
  const s = text
    .toLowerCase()
    .replace(/[.,()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return null;

  // Every-N-days patterns run BEFORE every-N-hours so "q 7 d" / "q 30 d"
  // aren't swallowed by the hours branch when it tolerates a missing
  // hour token. Handles q7d, q14d, q30d plus the longhand "every 7 days".
  const qD =
    s.match(/\bq\s*(\d+)\s*d(?:ay|ays)?\b/) ??
    s.match(/\bevery\s+(\d+)\s*(d|day|days)\b/);
  if (qD) {
    const n = Number(qD[1]);
    if (n === 7 || n === 14) return "weekly";
    if (n >= 28 && n <= 31) return "monthly";
    // Non-canonical intervals (q10d etc.) — fail open rather than
    // inventing a daily fraction.
    return null;
  }

  // Every-N-hours patterns: q2h, q2hr, q2hrs, q 2 h, q2, every 2 hours.
  // Hour unit is required here (unit regex is non-optional) because an
  // unqualified "q 7" is ambiguous — days vs hours vs generic — so we
  // require the `h/hr/hrs/hour/hours` marker to commit to hours.
  const qH =
    s.match(/\bq\s*(\d+)\s*(h|hr|hrs|hour|hours)\b/) ??
    s.match(/\bevery\s+(\d+)\s*(h|hr|hrs|hour|hours)\b/);
  if (qH) {
    const n = Number(qH[1]);
    if (n === 2) return "q2h";
    if (n === 3) return "q3h";
    if (n === 4) return "q4h";
    if (n === 6) return "q6h";
    if (n === 8) return "q8h";
    if (n === 12) return "q12h";
    if (n === 24) return "daily";
    // Non-canonical intervals (e.g. q5h) — we could compute 24/n but
    // clinicians rarely write these and being strict avoids false daily
    // sums for odd values. Return null to fail open.
    return null;
  }

  // PRN often appears in combination (e.g. "q4h prn"). The qH branch above
  // has already resolved paired-interval cases; by this point PRN means
  // the prescription has no fixed schedule — caller must supply
  // max_doses_per_day to make it boundable.
  const prnOnly = /\b(prn|as needed|as required)\b/.test(s);

  // Compound phrases BEFORE single-word generics: "once daily" must
  // resolve to `daily`, not match the `once` stat-shorthand below.
  if (/\b(twice daily|twice a day|2x daily|2x\s*\/\s*day)\b/.test(s)) return "bid";
  if (/\b(three times daily|3x daily|3x\s*\/\s*day)\b/.test(s)) return "tid";
  if (/\b(four times daily|4x daily|4x\s*\/\s*day)\b/.test(s)) return "qid";
  if (/\b(qd|q d|every day|once daily|once a day|daily|every 24 hours)\b/.test(s))
    return "daily";

  // Abbreviations AFTER the compound forms so "b i d" doesn't eat "bid in
  // evening" etc.
  if (/\b(bid|b i d)\b/.test(s)) return "bid";
  if (/\b(tid|t i d)\b/.test(s)) return "tid";
  if (/\b(qid|q i d)\b/.test(s)) return "qid";

  // Every-N-days → weekly/monthly approximations
  if (/\bq\s*7\s*d\b|\bweekly\b|\bevery week\b/.test(s)) return "weekly";
  if (/\bmonthly\b|\bevery month\b|\bq\s*30\s*d\b/.test(s)) return "monthly";

  // Stat / one-time shorthand. Kept AFTER the compound `once daily` check so
  // daily-recurring prescriptions that happen to contain the word "once" do
  // not collapse to a stat order.
  if (/\b(stat|one.?time|single dose|x1)\b/.test(s)) return "once";
  if (/\bonce\b/.test(s)) return "once"; // bare "once" — a stat order

  // PRN with no paired interval.
  if (prnOnly) return "prn";

  return null;
}

/**
 * Estimate the implied daily-cumulative dose (mg-equivalent units the
 * caller passes in). Returns null when the frequency can't be parsed or
 * when PRN is the frequency and no max_doses_per_day is supplied — the
 * caller should fail-open rather than flag.
 *
 * `maxDosesPerDay` caps whatever the frequency would imply. For example,
 * "morphine 10 mg q4h PRN, max 4 doses/day": frequency q4h gives 6/day,
 * but cap is 4 → 40 mg/day not 60 mg/day.
 */
export function estimateDailyDose(
  doseAmount: number | null | undefined,
  frequency: MedFrequency | null,
  maxDosesPerDay?: number | null,
): number | null {
  if (doseAmount == null || doseAmount <= 0) return null;
  if (frequency === null) return null;

  let dosesPerDay = FREQUENCY_DOSES_PER_DAY[frequency];

  // PRN-only prescriptions must have an explicit cap to be boundable.
  if (frequency === "prn") {
    if (maxDosesPerDay == null || maxDosesPerDay <= 0) return null;
    dosesPerDay = maxDosesPerDay;
  } else if (maxDosesPerDay != null && maxDosesPerDay > 0) {
    // Non-PRN with an explicit cap: take whichever is stricter. A scheduled
    // q4h prescription with max 3/day is unusual but explicit caps always
    // win.
    dosesPerDay = Math.min(dosesPerDay, maxDosesPerDay);
  }

  if (dosesPerDay === 0) return null; // `once` / unparseable PRN

  return doseAmount * dosesPerDay;
}
