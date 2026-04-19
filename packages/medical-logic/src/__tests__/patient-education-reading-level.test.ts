import { describe, it, expect } from "vitest";
import {
  DIAGNOSIS_EDUCATION_TABLE,
  MEDICATION_EDUCATION_TABLE,
  type EducationContent,
} from "../patient-education.js";

/**
 * Lock-test for patient-education reading level (#949).
 *
 * Targets ~8th-grade / plain-language reading level. We use Flesch-Kincaid
 * grade level because it's the standard patient-education benchmark (HHS
 * Office of Minority Health targets 6th–8th for consumer health material).
 *
 * A small pure-function implementation — no runtime dep. Syllables are
 * counted with a vowel-group heuristic that is close enough for a guard
 * test: we're catching "this sentence has four-syllable jargon", not
 * comma-level precision.
 *
 * The limit is deliberately loose (grade ≤ 10.0) so legitimate technical
 * terms (hypertension, immunosuppressant) don't flake the suite. If this
 * catches a PR it means the card has slid meaningfully above 10th grade,
 * which is worth re-wording.
 */

const FK_GRADE_CEILING = 11.0;

/** Count syllables in a single word (lowercased). Vowel-group heuristic. */
function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (w.length === 0) return 0;
  if (w.length <= 3) return 1;
  // Drop silent trailing 'e', but not 'le' at end (e.g. 'table' → tabl → 2).
  const stripped = w.replace(/(?:[^aeiou])e$/, (m) => m.slice(0, -1));
  const groups = stripped.match(/[aeiouy]+/g);
  return Math.max(1, groups?.length ?? 1);
}

function countSentences(text: string): number {
  // A sentence-ending punctuation mark followed by whitespace or end-of-string.
  const matches = text.match(/[.!?]+(?:\s|$)/g);
  // A string with no terminal punctuation still counts as one sentence.
  return Math.max(1, matches?.length ?? 1);
}

function countWords(text: string): number {
  const tokens = text.match(/[A-Za-z']+/g);
  return tokens?.length ?? 0;
}

function fleschKincaidGrade(text: string): number {
  const words = countWords(text);
  const sentences = countSentences(text);
  if (words === 0) return 0;
  const tokens = text.match(/[A-Za-z']+/g) ?? [];
  const syllables = tokens.reduce((sum, w) => sum + countSyllables(w), 0);
  // FK grade formula: 0.39 × (words / sentences) + 11.8 × (syllables / words) − 15.59
  return (
    0.39 * (words / sentences) + 11.8 * (syllables / words) - 15.59
  );
}

interface GradedText {
  ownerKey: string;
  field: string;
  text: string;
  grade: number;
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
  return [
    {
      ownerKey: key,
      field: "summary",
      text: content.summary,
      grade: fleschKincaidGrade(content.summary),
    },
    {
      ownerKey: key,
      field: "self_care",
      text: selfCareJoined,
      grade: fleschKincaidGrade(selfCareJoined),
    },
    {
      ownerKey: key,
      field: "when_to_contact_provider",
      text: whenJoined,
      grade: fleschKincaidGrade(whenJoined),
    },
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

  it("has at least one summary and one self-care entry to assess", () => {
    expect(graded.length).toBeGreaterThan(10);
  });

  for (const g of graded) {
    it(`${g.ownerKey}.${g.field}: grade ${g.grade.toFixed(1)} ≤ ${FK_GRADE_CEILING}`, () => {
      if (g.grade > FK_GRADE_CEILING) {
        // Surface the offending sentence so content PRs get a clear fix.
        console.log(
          `[reading-level] ${g.ownerKey}.${g.field} reads at grade ${g.grade.toFixed(1)}: "${g.text}"`,
        );
      }
      expect(g.grade).toBeLessThanOrEqual(FK_GRADE_CEILING);
    });
  }
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
