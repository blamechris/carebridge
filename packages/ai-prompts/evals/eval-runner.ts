/**
 * Golden-eval runner for clinical-review prompt regression detection.
 *
 * Loads fixture files, runs each through buildReviewPrompt, and validates
 * that the generated prompt contains the expected clinical data. This is a
 * record-and-replay harness — no live API calls are made.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildReviewPrompt } from "../src/clinical-review.js";
import { estimateTokens, enforceTokenBudget, DEFAULT_TOKEN_BUDGET } from "../src/token-budget.js";
import type { ReviewContext } from "../src/clinical-review.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "fixtures");

export interface EvalFixture {
  id: string;
  description: string;
  context: ReviewContext;
  expected: {
    shouldFlag: boolean;
    expectedCategories?: string[];
    forbiddenCategories?: string[];
    minimumSeverity?: "critical" | "warning" | "info";
    mustMentionInPrompt: string[];
  };
}

export interface EvalResult {
  fixtureId: string;
  passed: boolean;
  prompt: string;
  tokenCount: number;
  withinBudget: boolean;
  missingMentions: string[];
  errors: string[];
}

export function loadFixtures(): EvalFixture[] {
  const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
  return files.map((file) => {
    const raw = readFileSync(join(FIXTURES_DIR, file), "utf-8");
    return JSON.parse(raw) as EvalFixture;
  });
}

export function evaluateFixture(fixture: EvalFixture): EvalResult {
  const errors: string[] = [];

  // Build the prompt from the fixture context
  const prompt = buildReviewPrompt(fixture.context);

  // Check token budget compliance
  const tokenCount = estimateTokens(prompt);
  const withinBudget = tokenCount <= DEFAULT_TOKEN_BUDGET;

  if (!withinBudget) {
    errors.push(
      `Prompt exceeds token budget: ${tokenCount} > ${DEFAULT_TOKEN_BUDGET}`,
    );
  }

  // Verify enforceTokenBudget does not corrupt the prompt when within budget
  const budgetResult = enforceTokenBudget(prompt);
  if (budgetResult.truncated && withinBudget) {
    errors.push(
      "enforceTokenBudget truncated a prompt that was within budget",
    );
  }

  // Check that expected strings appear in the generated prompt
  const missingMentions: string[] = [];
  for (const mention of fixture.expected.mustMentionInPrompt) {
    if (!prompt.includes(mention)) {
      missingMentions.push(mention);
      errors.push(`Expected prompt to mention "${mention}" but it was not found`);
    }
  }

  // Verify prompt structure contains required section headers
  const requiredSections = [
    "PATIENT CLINICAL CONTEXT",
    "Demographics",
    "Active Diagnoses",
    "Allergies",
    "Active Medications",
    "TRIGGERING EVENT",
  ];
  for (const section of requiredSections) {
    if (!prompt.includes(section)) {
      errors.push(`Missing required section header: "${section}"`);
    }
  }

  return {
    fixtureId: fixture.id,
    passed: errors.length === 0,
    prompt,
    tokenCount,
    withinBudget,
    missingMentions,
    errors,
  };
}

export function runAllEvals(): EvalResult[] {
  const fixtures = loadFixtures();
  return fixtures.map(evaluateFixture);
}
