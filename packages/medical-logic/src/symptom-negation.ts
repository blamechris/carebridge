/**
 * Negation-aware symptom detection (#1307).
 *
 * Clinical free text — chief complaint, HPI, ROS — routinely lists what a
 * patient is NOT experiencing alongside what they are. A naive
 * `text.includes("fever")` check fires the febrile-neutropenia rule even on a
 * note whose HPI explicitly says "no fever, no neck stiffness, no nausea",
 * which trains clinicians to dismiss the warning and undermines true
 * febrile-neutropenia alerts (a 60-minute time-to-antibiotic emergency).
 *
 * `hasUnnegatedMention` returns true only when `term` appears in `text` AND
 * the immediately preceding ~5-token window does not contain a negation
 * marker. The helper is intentionally small and deterministic — no LLM, no
 * sprawling regex zoo — so it can be reused by the UI symptom autocomplete
 * (#1305) without dragging a heavy NLP dependency into the browser bundle.
 *
 * Negation forms handled:
 *   - `no <term>`                   ("no fever")
 *   - `not <term>`                  ("patient is not febrile")
 *   - `denies <term>`               ("denies fever")
 *   - `without <term>`              ("admitted without fever")
 *   - `absent <term>`               ("fever absent on exam" — post-term)
 *   - `absence of <term>`           ("absence of fever")
 *   - `negative for <term>`         ("ROS negative for fever, chills")
 *   - `<term>-free`                 ("fever-free x 24h")
 *   - `no h/o <term>`               ("no h/o fever")
 *   - `no history of <term>`        ("no history of fever")
 *
 * Comma-separated list form (common in HPI/ROS) — "no fever, no neck
 * stiffness, no nausea" — works without special handling because each item
 * carries its own leading "no" within the lookback window. The
 * "negative for X, Y, Z" form is supported because the lookback walks
 * through commas; tokens before commas still count toward the window.
 */

// Negation markers that appear BEFORE the term within the lookback window.
const PRE_NEGATIONS = new Set([
  "no",
  "not",
  "denies",
  "denied",
  "without",
  "absent",
  "absence",
  "negative",
  "neg",
]);

// Words that often appear between a pre-negation and the term and should
// not "consume" the negator. E.g. "no h/o fever" has tokens [no, h, o, fever];
// "no history of fever" has [no, history, of, fever]; "negative for fever"
// has [negative, for, fever]. These linker tokens get skipped when scanning
// back so the window stays anchored on the term itself.
const LINKER_TOKENS = new Set([
  "for",
  "of",
  "any",
  "the",
  "a",
  "an",
  "h",
  "o",
  "ho",
  "h/o",
  "hx",
  "history",
  "evidence",
  "signs",
  "sign",
  "symptoms",
  "symptom",
  "complaints",
  "complaint",
]);

// Tokens that terminate the lookback — a sentence boundary breaks the
// negation chain. Commas DO NOT terminate (so "no fever, chills" negates
// both items in the list).
const HARD_BOUNDARIES = new Set([".", ";", ":", "!", "?"]);

// Conjunctions that bridge list items and should NOT break a negation chain.
const SOFT_BRIDGES = new Set([",", "and", "or"]);

const LOOKBACK_WINDOW = 5;

/**
 * Tokenize a free-text clinical string into a flat list of lower-cased
 * tokens, preserving sentence-terminator punctuation and commas as their
 * own tokens so the negation scanner can detect boundaries and bridges.
 *
 * Slashes (h/o), apostrophes, and hyphens are kept inside tokens so
 * "fever-free" tokenizes as a single hyphenated token, which lets us
 * detect the post-term "-free" negation form by simple suffix check.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  // Split on whitespace; then split off leading/trailing punctuation that
  // matters (.,;:!?) while keeping hyphens and slashes inside the token.
  for (const raw of text.toLowerCase().split(/\s+/)) {
    if (!raw) continue;
    let current = raw;
    // Strip leading boundary punctuation.
    while (current.length > 0 && /^[.,;:!?]/.test(current)) {
      tokens.push(current[0]!);
      current = current.slice(1);
    }
    // Collect trailing boundary punctuation to push AFTER the word body.
    const trailing: string[] = [];
    while (current.length > 0 && /[.,;:!?]$/.test(current)) {
      trailing.unshift(current.slice(-1));
      current = current.slice(0, -1);
    }
    if (current.length > 0) tokens.push(current);
    for (const t of trailing) tokens.push(t);
  }
  return tokens;
}

/**
 * Find all start indices in `tokens` where the (already-tokenized) `needle`
 * appears as a contiguous sub-sequence. Returns indices into the haystack
 * tokens array, NOT character offsets.
 */
function findTermStartIndices(
  haystack: string[],
  needle: string[],
): number[] {
  const out: number[] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    let matched = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        matched = false;
        break;
      }
    }
    if (matched) out.push(i);
  }
  return out;
}

/**
 * Return true if the token at `termStart` is negated by something in the
 * preceding ~5 non-linker tokens, OR by a post-term marker ("absent",
 * "<term>-free").
 */
function isOccurrenceNegated(
  tokens: string[],
  termStart: number,
  termLength: number,
): boolean {
  // ── Post-term negation: "fever absent" / "fever absent on exam" ─────────
  const postIdx = termStart + termLength;
  if (postIdx < tokens.length) {
    const next = tokens[postIdx]!;
    if (next === "absent") return true;
  }

  // ── Post-term hyphenated form: "fever-free" tokenized as one token ─────
  // Tokenizer keeps hyphens inside tokens, so "fever-free" matched against
  // the needle "fever" via the multi-token sub-sequence search WOULD NOT
  // match (the haystack token is "fever-free", not "fever"). Handle it by
  // checking any token in haystack that contains the needle followed by
  // "-free" or "-negative".
  // (See the explicit scan below — easier than threading through the loop.)

  // ── Pre-term negation: scan backwards up to LOOKBACK_WINDOW non-linker
  // tokens. Stop on hard sentence boundaries.
  let stepsTaken = 0;
  for (let i = termStart - 1; i >= 0 && stepsTaken < LOOKBACK_WINDOW; i--) {
    const tok = tokens[i]!;
    if (HARD_BOUNDARIES.has(tok)) return false;
    if (SOFT_BRIDGES.has(tok)) {
      // Don't count comma/and/or against the window — they bridge list
      // items but do not consume a "slot".
      continue;
    }
    if (LINKER_TOKENS.has(tok)) {
      // Skip linkers (for, of, h, history, ...) without consuming a slot.
      continue;
    }
    if (PRE_NEGATIONS.has(tok)) return true;
    stepsTaken++;
  }
  return false;
}

/**
 * Return true if `term` appears in `text` as a non-negated mention.
 *
 * - Empty `text` or empty `term` → false.
 * - Term matching is whole-word (so "feverfew" does NOT match "fever").
 * - Multi-word terms ("neck stiffness") are supported.
 * - Case-insensitive on both sides.
 *
 * If ANY occurrence of the term in the text is non-negated, returns true.
 * Only when EVERY occurrence is negated does it return false. This matches
 * the clinical intent: a single positive mention overrides earlier
 * negatives ("No fever on admission; now reports fever 102").
 */
export function hasUnnegatedMention(text: string, term: string): boolean {
  if (!text || !term) return false;
  const haystack = tokenize(text);
  const needle = tokenize(term);
  if (needle.length === 0) return false;

  // Detect "<term>-free" / "<term>-negative" suffix forms directly on the
  // raw lowercase haystack tokens, since the tokenizer keeps hyphens in
  // the token body.
  const hyphenatedNegatedForms = new Set<string>();
  const needleJoined = needle.join("-");
  hyphenatedNegatedForms.add(`${needleJoined}-free`);
  hyphenatedNegatedForms.add(`${needleJoined}-negative`);

  // Walk the haystack for either the whole-word multi-token needle OR a
  // hyphenated negated form.
  const occurrences = findTermStartIndices(haystack, needle);

  // If there are no whole-word occurrences but a hyphenated-negated form
  // exists, the term DID appear in the text — but only in a negated form.
  // Return false: no unnegated mention.
  if (occurrences.length === 0) {
    for (const tok of haystack) {
      if (hyphenatedNegatedForms.has(tok)) return false;
    }
    return false;
  }

  for (const start of occurrences) {
    if (!isOccurrenceNegated(haystack, start, needle.length)) {
      return true;
    }
  }
  return false;
}
