/**
 * Package-surface sanity test for the helpers re-exported from
 * `services/epic-connector/src/index.ts` so that admin tooling and
 * downstream consumers do not have to deep-import from `sync/sync-jobs.js`
 * (#1133).
 *
 * Re-export drift between the named helper definitions and the package
 * barrel is silent at the type level — this guard surfaces it.
 */
import { describe, it, expect } from "vitest";
import {
  isMissingRequiredElementError,
  describeMissingElement,
  sanitizeMissingElementForPersistence,
  EpicFhirError,
  EPIC_ERROR_CODES,
} from "../index.js";

describe("epic-connector index surface (#1133)", () => {
  it("re-exports isMissingRequiredElementError", () => {
    expect(typeof isMissingRequiredElementError).toBe("function");
  });

  it("re-exports describeMissingElement", () => {
    expect(typeof describeMissingElement).toBe("function");
  });

  it("isMissingRequiredElementError detects an EpicFhirError carrying 59108", () => {
    const outcome = {
      resourceType: "OperationOutcome" as const,
      issue: [
        {
          severity: "error" as const,
          code: "required",
          details: {
            coding: [
              {
                system: "https://open.epic.com/error-codes",
                code: EPIC_ERROR_CODES.MISSING_REQUIRED_ELEMENT,
              },
            ],
            text: "A required element is missing",
          },
          diagnostics: "MedicationRequest.intent is required",
        },
      ],
    };
    const err = new EpicFhirError(
      "Epic returned OperationOutcome",
      400,
      "Bad Request",
      JSON.stringify(outcome),
      outcome,
    );
    expect(isMissingRequiredElementError(err)).toBe(true);
  });

  it("isMissingRequiredElementError rejects non-Epic errors", () => {
    expect(isMissingRequiredElementError(new Error("boom"))).toBe(false);
    expect(isMissingRequiredElementError(undefined)).toBe(false);
  });

  it("describeMissingElement extracts the diagnostics field", () => {
    const outcome = {
      resourceType: "OperationOutcome" as const,
      issue: [
        {
          severity: "error" as const,
          code: "required",
          diagnostics: "Observation.category is required",
        },
      ],
    };
    const err = new EpicFhirError("x", 400, "Bad Request", "{}", outcome);
    expect(describeMissingElement(err)).toBe("Observation.category is required");
  });

  it("describeMissingElement returns a fallback for errors without an OperationOutcome", () => {
    expect(describeMissingElement(new Error("boom"))).toBe(
      "missing element (no diagnostics)",
    );
  });

  it("re-exports sanitizeMissingElementForPersistence (#1132)", () => {
    expect(typeof sanitizeMissingElementForPersistence).toBe("function");
    expect(sanitizeMissingElementForPersistence("MedicationRequest.intent")).toBe(
      "MedicationRequest.intent",
    );
    expect(sanitizeMissingElementForPersistence("free form text")).toBe(
      "missing element (see logs)",
    );
  });
});
