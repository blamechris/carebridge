/**
 * Token budget enforcement for Claude API calls.
 *
 * Prevents oversized prompts from exceeding the context window or
 * wasting money. Uses a rough character-based estimation (~4 chars
 * per token for English clinical text) and section-aware truncation
 * that preserves the most clinically relevant data.
 */

import { PROMPT_SECTIONS } from "./prompt-sections.js";

/** Rough token estimation: ~4 chars per token for English text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Default budget: 150k tokens.
 * Claude has a 200k context window — leave headroom for the system
 * prompt (~2k tokens) and max_tokens output (4k default).
 */
export const DEFAULT_TOKEN_BUDGET = 150_000;

export interface TruncationResult {
  prompt: string;
  truncated: boolean;
  originalTokens: number;
  finalTokens: number;
  sectionsRemoved: string[];
}

// ─── Section markers used by buildReviewPrompt ─────────────────────

const SECTION_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "recent_labs", regex: new RegExp(`${PROMPT_SECTIONS.LABS}:\\n([\\s\\S]*?)(?=\\n\\n|\\n${PROMPT_SECTIONS.CARE_TEAM}:|\\n${PROMPT_SECTIONS.TRIGGERING_EVENT})`) },
  { name: "latest_vitals", regex: new RegExp(`${PROMPT_SECTIONS.VITALS}:\\n([\\s\\S]*?)(?=\\n\\n|\\n${PROMPT_SECTIONS.LABS}:|\\n${PROMPT_SECTIONS.CARE_TEAM}:)`) },
  { name: "active_medications", regex: new RegExp(`${PROMPT_SECTIONS.MEDICATIONS}:\\n([\\s\\S]*?)(?=\\n\\n|\\n${PROMPT_SECTIONS.VITALS}:)`) },
  { name: "recent_flags", regex: new RegExp(`${PROMPT_SECTIONS.FLAGS}:\\n([\\s\\S]*?)(?=\\n\\n|\\n${PROMPT_SECTIONS.TRIGGERING_EVENT})`) },
];

/**
 * Trim list items in a section to keep only the most recent N entries.
 * Returns the modified text and whether anything was removed.
 */
function trimSectionItems(
  text: string,
  sectionRegex: RegExp,
  keepCount: number,
): { text: string; removed: boolean } {
  const match = sectionRegex.exec(text);
  if (!match || !match[1]) return { text, removed: false };

  const lines = match[1].split("\n").filter((l) => l.trimStart().startsWith("-"));
  if (lines.length <= keepCount) return { text, removed: false };

  // Keep the last N items (most recent, since prompts list chronologically)
  const kept = lines.slice(-keepCount).join("\n");
  const trimmed = text.replace(match[1], kept + "\n");
  return { text: trimmed, removed: true };
}

/**
 * Enforce a token budget on the assembled prompt.
 *
 * Truncation strategy (least-important data removed first):
 *   1. Trim older lab results — keep last 5 panels
 *   2. Trim older vitals — keep last 10
 *   3. Trim medication history — keep last 15
 *   4. Trim recent flags — keep last 5
 *   5. If still over budget, hard-truncate the prompt with an ellipsis marker
 */
export function enforceTokenBudget(
  prompt: string,
  budget: number = DEFAULT_TOKEN_BUDGET,
): TruncationResult {
  const originalTokens = estimateTokens(prompt);

  if (originalTokens <= budget) {
    return {
      prompt,
      truncated: false,
      originalTokens,
      finalTokens: originalTokens,
      sectionsRemoved: [],
    };
  }

  let current = prompt;
  const sectionsRemoved: string[] = [];

  // Trim sections in priority order (least important first)
  const TRIM_PRIORITY = [
    { section: SECTION_PATTERNS[0], keepCount: 5 },
    { section: SECTION_PATTERNS[1], keepCount: 10 },
    { section: SECTION_PATTERNS[2], keepCount: 15 },
    { section: SECTION_PATTERNS[3], keepCount: 5 },
  ];

  for (const { section, keepCount } of TRIM_PRIORITY) {
    if (estimateTokens(current) <= budget) break;

    const trimResult = trimSectionItems(current, section.regex, keepCount);
    if (trimResult.removed) {
      current = trimResult.text;
      sectionsRemoved.push(`${section.name} (trimmed to ${keepCount})`);
    }
  }

  if (estimateTokens(current) <= budget) {
    return result(current, originalTokens, sectionsRemoved);
  }

  // Step 5: Hard truncate as last resort — preserve the triggering event at the end
  const budgetChars = budget * 4;
  const triggerMarker = PROMPT_SECTIONS.TRIGGERING_EVENT;
  const triggerIdx = current.indexOf(triggerMarker);

  if (triggerIdx !== -1) {
    const triggerSection = current.slice(triggerIdx);
    const remainingBudget = budgetChars - triggerSection.length - 50; // 50 chars for ellipsis marker
    if (remainingBudget > 0) {
      current =
        current.slice(0, remainingBudget) +
        "\n\n[... context truncated for token budget ...]\n\n" +
        triggerSection;
    } else {
      current = current.slice(0, budgetChars);
    }
  } else {
    current = current.slice(0, budgetChars);
  }

  sectionsRemoved.push("hard_truncation");
  return result(current, originalTokens, sectionsRemoved);
}

function result(
  prompt: string,
  originalTokens: number,
  sectionsRemoved: string[],
): TruncationResult {
  return {
    prompt,
    truncated: true,
    originalTokens,
    finalTokens: estimateTokens(prompt),
    sectionsRemoved,
  };
}
