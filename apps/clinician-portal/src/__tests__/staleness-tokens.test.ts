import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Issues #523, #526, #530: StaleDataBanner / stalenessStyles reference
 * `var(--color-warning-*, fallback)` and `var(--color-muted-*, fallback)`
 * design tokens. If the tokens aren't defined in globals.css the inline
 * hex fallbacks (Bootstrap mustard, not the Apple-dark palette) always
 * win and theme overrides silently have no effect.
 *
 * This assertion is a guardrail: any future rename or removal of the
 * tokens must be accompanied by a matching update in page.tsx.
 */
describe("clinician-portal globals.css — staleness design tokens", () => {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const globalsPath = resolve(__dirname, "../../app/globals.css");
  const css = readFileSync(globalsPath, "utf8");

  const required = [
    "--color-warning-bg",
    "--color-warning-border",
    "--color-warning-text",
    "--color-muted-bg",
    "--color-muted-border",
  ];

  for (const token of required) {
    it(`defines ${token} in :root`, () => {
      // Match the declaration (`--token-name:` — whitespace tolerant)
      // rather than just the bare name, which would also match `var(...)`
      // usages elsewhere in the stylesheet.
      const declaration = new RegExp(`${token}\\s*:`);
      expect(css).toMatch(declaration);
    });
  }
});
