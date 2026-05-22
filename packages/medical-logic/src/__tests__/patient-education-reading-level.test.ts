import { describe, it, expect } from "vitest";
import {
  DIAGNOSIS_EDUCATION_TABLE,
  MEDICATION_EDUCATION_TABLE,
  type EducationContent,
} from "../patient-education.js";

/**
 * Lock-test for patient-education reading level (#949, extended in #975).
 *
 * Targets ~8th-grade / plain-language reading level. We use three
 * independent grade-level metrics so the guard is robust to gaming any
 * single formula:
 *
 *   - Flesch-Kincaid (FK)  — standard patient-education benchmark.
 *     Sensitive to sentence length and syllable density.
 *     HHS Office of Minority Health targets 6th–8th for consumer health
 *     material.
 *
 *   - SMOG Index           — McLaughlin 1969. Focuses on polysyllable
 *     density and is stable on short bullet lists where FK gets noisy
 *     because words/sentences collapses to a tiny ratio.
 *
 *   - Gunning-Fog          — Gunning 1952. Combines sentence length and
 *     hard-word density; tends to read 1–2 grades above FK on the same
 *     text and complements both FK and SMOG.
 *
 * ALL THREE must be at or below ceiling for the card to pass. FK alone
 * can be gamed by short fragments; SMOG alone misses long-but-simple
 * prose; Gunning-Fog alone is sensitive to sentence punctuation. The
 * intersection catches each failure mode.
 *
 * Pure-function implementations — no runtime deps. Syllables are counted
 * with a vowel-group heuristic that is close enough for a guard test:
 * we're catching "this sentence has four-syllable jargon", not
 * comma-level precision.
 *
 * Ceilings are deliberately loose so legitimate technical terms
 * (hypertension, immunosuppressant) don't flake the suite. If any of the
 * three catches a PR it means the card has slid meaningfully above
 * mid-high-school reading level — worth re-wording.
 *
 * Multilingual roadmap is documented in
 * `docs/patient-education-readability.md`; until non-English cards land,
 * these English-tuned formulas are the only guard.
 */

const FK_GRADE_CEILING = 11.0;
const SMOG_GRADE_CEILING = 13.0;
const FOG_GRADE_CEILING = 13.0;

/** Count syllables in a single word (lowercased). Vowel-group heuristic. */
function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  // Drop silent trailing 'e', but keep the syllable for consonant+'le'
  // endings (e.g. 'table' → 'table' stays 2; 'make' → 'mak' drops to 1).
  const stripped = /[^aeiou]le$/.test(w)
    ? w
    : w.replace(/(?:[^aeiou])e$/, (m) => m.slice(0, -1));
  const groups = stripped.match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}

function countSentences(text: string): number {
  // A sentence-ending punctuation mark followed by whitespace or end-of-string.
  const matches = text.match(/[.!?]+(?:\s|$)/g);
  // A string with no terminal punctuation still counts as one sentence.
  return Math.max(1, matches?.length ?? 1);
}

function tokenizeWords(text: string): string[] {
  return text.match(/[A-Za-z']+/g) ?? [];
}

function fleschKincaidGrade(text: string): number {
  const tokens = tokenizeWords(text);
  const words = tokens.length;
  if (words === 0) return 0;
  const sentences = countSentences(text);
  const syllables = tokens.reduce((sum, w) => sum + countSyllables(w), 0);
  // FK grade formula: 0.39 × (words / sentences) + 11.8 × (syllables / words) − 15.59
  return (
    0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59
  );
}

/**
 * SMOG Index (McLaughlin 1969). Returns a grade-level estimate based on
 * polysyllable density and sentence count.
 *
 *   SMOG grade = 1.0430 × √(polysyllables × 30 / sentences) + 3.1291
 *
 * Polysyllable = a word with 3 or more syllables. The canonical formula
 * is calibrated to a sample of 30 sentences; for short content we apply
 * the formula with the actual sentence count, which is the standard
 * approximation. (#975)
 */
function smogGrade(text: string): number {
  const tokens = tokenizeWords(text);
  if (tokens.length === 0) return 0;
  const sentences = countSentences(text);
  const polysyllables = tokens.filter((w) => countSyllables(w) >= 3).length;
  return (
    1.0430 * Math.sqrt((polysyllables * 30) / sentences) + 3.1291
  );
}

/**
 * Gunning-Fog Index (Gunning 1952). Combines sentence length with the
 * density of "hard" words (3+ syllables, excluding common -es / -ed /
 * -ing inflections which the original heuristic also dropped).
 *
 *   Fog = 0.4 × ((words / sentences) + 100 × (hard_words / words))
 *
 * (#975)
 */
function gunningFogGrade(text: string): number {
  const tokens = tokenizeWords(text);
  const words = tokens.length;
  if (words === 0) return 0;
  const sentences = countSentences(text);
  const hardWords = tokens.filter((w) => {
    const lower = w.toLowerCase();
    // Strip common inflectional endings before counting syllables —
    // "process" is hard, "processed" / "processes" / "processing" are
    // treated as the same word per Gunning's original definition.
    const stripped = lower
      .replace(/(?:ed|es|ing)$/i, "")
      .replace(/[^a-z]/g, "");
    return countSyllables(stripped) >= 3;
  }).length;
  return 0.4 * (words / sentences + 100 * (hardWords / words));
}

interface GradedText {
  ownerKey: string;
  field: string;
  text: string;
  fk: number;
  smog: number;
  fog: number;
}

/**
 * Grade at content-block granularity (summary, self_care joined, when_to
 * joined) rather than per-sentence. A single 10-word bullet inflates FK
 * because the words/sentence ratio is tiny; the block-level score better
 * reflects what a patient actually reads.
 */
function gradeEveryBlock(
  key: string,
  content: EducationContent,
): GradedText[] {
  const selfCareJoined = content.self_care.join(" ");
  const whenJoined = content.when_to_contact_provider.join(" ");
  function score(field: string, text: string): GradedText {
    return {
      ownerKey: key,
      field,
      text,
      fk: fleschKincaidGrade(text),
      smog: smogGrade(text),
      fog: gunningFogGrade(text),
    };
  }
  return [
    score("summary", content.summary),
    score("self_care", selfCareJoined),
    score("when_to_contact_provider", whenJoined),
  ];
}

describe("patient-education reading level (#949)", () => {
  const graded: GradedText[] = [];
  for (const [k, v] of Object.entries(DIAGNOSIS_EDUCATION_TABLE)) {
    graded.push(...gradeEveryBlock(k, v));
  }
  for (const [k, v] of Object.entries(MEDICATION_EDUCATION_TABLE)) {
    graded.push(...gradeEveryBlock(k, v));
  }

  it("grades every field (summary / self_care / when_to_contact_provider) for multiple cards", () => {
    expect(graded.length).toBeGreaterThan(10);
    const fields = new Set(graded.map((g) => g.field));
    expect(fields.has("summary")).toBe(true);
    expect(fields.has("self_care")).toBe(true);
    expect(fields.has("when_to_contact_provider")).toBe(true);
  });

  for (const g of graded) {
    it(`${g.ownerKey}.${g.field}: FK ${g.fk.toFixed(1)} ≤ ${FK_GRADE_CEILING}, SMOG ${g.smog.toFixed(1)} ≤ ${SMOG_GRADE_CEILING}, Fog ${g.fog.toFixed(1)} ≤ ${FOG_GRADE_CEILING}`, () => {
      if (
        g.fk > FK_GRADE_CEILING ||
        g.smog > SMOG_GRADE_CEILING ||
        g.fog > FOG_GRADE_CEILING
      ) {
        // Surface the offending block so content PRs get a clear fix.
        console.log(
          `[reading-level] ${g.ownerKey}.${g.field}: FK=${g.fk.toFixed(1)} SMOG=${g.smog.toFixed(1)} Fog=${g.fog.toFixed(1)}: "${g.text}"`,
        );
      }
      expect(g.fk, `${g.ownerKey}.${g.field} FK`).toBeLessThanOrEqual(FK_GRADE_CEILING);
      expect(g.smog, `${g.ownerKey}.${g.field} SMOG`).toBeLessThanOrEqual(SMOG_GRADE_CEILING);
      expect(g.fog, `${g.ownerKey}.${g.field} Fog`).toBeLessThanOrEqual(FOG_GRADE_CEILING);
    });
  }
});

describe("smogGrade sanity (#975)", () => {
  it("elementary writing scores in single digits", () => {
    const s = smogGrade("The dog ran fast. The cat sat. Birds fly high.");
    expect(s).toBeLessThan(8);
  });

  it("polysyllable-dense prose scores meaningfully higher", () => {
    const s = smogGrade(
      "Immunosuppressant pharmacotherapy necessitates stringent immunological surveillance in transplantation recipients.",
    );
    expect(s).toBeGreaterThan(10);
  });
});

describe("gunningFogGrade sanity (#975)", () => {
  it("elementary writing scores in single digits", () => {
    const f = gunningFogGrade("The dog ran fast. The cat sat. Birds fly high.");
    expect(f).toBeLessThan(8);
  });

  it("polysyllable-dense prose scores meaningfully higher", () => {
    const f = gunningFogGrade(
      "Immunosuppressant pharmacotherapy necessitates stringent immunological surveillance in transplantation recipients.",
    );
    expect(f).toBeGreaterThan(15);
  });
});

describe("fleschKincaidGrade sanity (#949)", () => {
  it("elementary writing scores in the low single digits", () => {
    // "The dog ran fast" — simple words, short.
    const g = fleschKincaidGrade("The dog ran fast. The cat sat.");
    expect(g).toBeLessThan(5);
  });

  it("technical prose scores meaningfully higher", () => {
    const g = fleschKincaidGrade(
      "Immunosuppressant pharmacotherapy necessitates stringent immunological surveillance in transplant recipients.",
    );
    expect(g).toBeGreaterThan(10);
  });
});
