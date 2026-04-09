/**
 * Evaluate a set of check-in responses against a template's declarative
 * red-flag rules. Pure and side-effect free so it's trivial to unit
 * test; consumed both by the submit path (to stamp `red_flag_hits` at
 * write time) and by the Phase B4 rule engine (to re-derive hits for
 * the review worker without trusting the stored column).
 *
 * The matching is intentionally conservative: a question with no
 * declared `red_flag` never fires, and unknown answer shapes (type
 * mismatch, missing key) never fire. Red-flag detection exists to
 * surface affirmative harm signals, not to punish incomplete forms.
 */

import type {
  CheckInQuestion,
  CheckInResponses,
} from "@carebridge/validators";

/**
 * Given a template's questions and a submission's responses, return
 * the list of question ids whose answers match the question's declared
 * red-flag rule. Order follows the declared question order for stable
 * rendering in UI and audit output.
 */
export function evaluateRedFlagHits(
  questions: CheckInQuestion[],
  responses: CheckInResponses,
): string[] {
  const hits: string[] = [];
  for (const q of questions) {
    if (!q.red_flag) continue;
    const answer = responses[q.id];
    if (answer === undefined) continue;
    if (matchesRedFlag(q, answer)) {
      hits.push(q.id);
    }
  }
  return hits;
}

function matchesRedFlag(
  q: CheckInQuestion,
  answer: unknown,
): boolean {
  const rf = q.red_flag;
  if (!rf) return false;

  switch (rf.kind) {
    case "bool": {
      if (typeof answer !== "boolean") return false;
      return answer === rf.when;
    }
    case "threshold": {
      if (typeof answer !== "number") return false;
      if (rf.gte !== undefined && answer < rf.gte) return false;
      if (rf.lte !== undefined && answer > rf.lte) return false;
      // Require at least one of gte/lte to be defined, otherwise we'd
      // match every numeric answer, which is never the intent.
      if (rf.gte === undefined && rf.lte === undefined) return false;
      return true;
    }
    case "values": {
      if (typeof answer === "string") {
        return rf.values.includes(answer);
      }
      if (Array.isArray(answer)) {
        return answer.some(
          (v) => typeof v === "string" && rf.values.includes(v),
        );
      }
      return false;
    }
    default: {
      // Exhaustiveness guard — if a new kind is added to the schema
      // and this switch isn't updated, TS will error here at build.
      const _never: never = rf;
      void _never;
      return false;
    }
  }
}
