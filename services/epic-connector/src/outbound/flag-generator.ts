/**
 * CareBridge ClinicalFlag → FHIR R4 Flag generator (#393).
 *
 * FHIR R4 Flag spec: https://www.hl7.org/fhir/flag.html
 *
 * Mapping decisions:
 *  - status:    open|acknowledged|escalated → "active"
 *               resolved|dismissed         → "inactive"
 *  - category:  always [{ system: "http://terminology.hl7.org/CodeSystem/flag-category", code: "clinical" }]
 *  - code:      summary as the text + a CareBridge-internal severity coding
 *               so Epic can render severity bands in its banner UI
 *  - subject:   Patient/<epic-patient-fhir-id> when available, otherwise
 *               internal `Patient/<carebridge-id>` (callers should pass
 *               the Epic id for cross-system referential integrity)
 *  - period.start: flag.created_at
 *  - period.end:   set when the flag is inactive — picks the
 *                  latest resolved_at / dismissed_at
 *  - author:    Organization reference identifying CareBridge as the
 *               flag's origin — Epic typically requires a sourced
 *               author when the flag isn't authored by an Epic user
 *  - extension: rationale and suggested_action surface as FHIR
 *               extensions so they're visible alongside the flag
 *               without polluting the standard code.text field
 */
import type {
  ClinicalFlag,
  FlagStatus,
  FlagSeverity,
} from "@carebridge/shared-types";

export const CAREBRIDGE_FLAG_SEVERITY_SYSTEM =
  "https://carebridge.dev/fhir/CodeSystem/flag-severity";

export const CAREBRIDGE_FLAG_CATEGORY_SYSTEM =
  "https://carebridge.dev/fhir/CodeSystem/flag-category";

export const FHIR_FLAG_CATEGORY_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/flag-category";

export const RATIONALE_EXTENSION_URL =
  "https://carebridge.dev/fhir/StructureDefinition/flag-rationale";

export const SUGGESTED_ACTION_EXTENSION_URL =
  "https://carebridge.dev/fhir/StructureDefinition/flag-suggested-action";

export const RULE_ID_EXTENSION_URL =
  "https://carebridge.dev/fhir/StructureDefinition/flag-rule-id";

export const CAREBRIDGE_ORGANIZATION_REFERENCE = "Organization/carebridge" as const;

export interface FhirFlag {
  resourceType: "Flag";
  id?: string;
  status: "active" | "inactive" | "entered-in-error";
  category: Array<{
    coding: Array<{ system: string; code: string; display?: string }>;
  }>;
  code: {
    coding: Array<{ system: string; code: string; display?: string }>;
    text: string;
  };
  subject: { reference: string };
  period?: { start?: string; end?: string };
  author?: { reference: string };
  extension?: Array<{
    url: string;
    valueString?: string;
  }>;
  /** Passthrough for fields we don't model — keeps FhirFlag assignable to FhirResource. */
  [k: string]: unknown;
}

export interface BuildFhirFlagArgs {
  flag: Pick<
    ClinicalFlag,
    | "summary"
    | "rationale"
    | "suggested_action"
    | "severity"
    | "category"
    | "status"
    | "rule_id"
    | "created_at"
    | "resolved_at"
    | "dismissed_at"
  >;
  /**
   * FHIR Patient.id on Epic's side. Prefer the Epic id over the
   * CareBridge UUID so the resource references resolve correctly when
   * Epic's UI dereferences `subject.reference`.
   */
  epicPatientFhirId: string;
  /**
   * Optional existing Epic Flag id — set when generating a payload
   * for a PUT (status update) so the output carries the right
   * resource id.
   */
  epicFlagId?: string;
}

/**
 * Map the internal CareBridge severity enum to a FHIR Flag.code coding.
 * Display values are clinician-readable strings Epic surfaces in the
 * Storyboard banner.
 */
export function flagSeverityCoding(severity: FlagSeverity): {
  system: string;
  code: FlagSeverity;
  display: string;
} {
  switch (severity) {
    case "critical":
      return {
        system: CAREBRIDGE_FLAG_SEVERITY_SYSTEM,
        code: "critical",
        display: "Critical — immediate clinician attention required",
      };
    case "warning":
      return {
        system: CAREBRIDGE_FLAG_SEVERITY_SYSTEM,
        code: "warning",
        display: "Warning — review recommended",
      };
    case "info":
      return {
        system: CAREBRIDGE_FLAG_SEVERITY_SYSTEM,
        code: "info",
        display: "Informational",
      };
  }
}

/**
 * Map the internal FlagStatus to FHIR Flag.status. Resolved /
 * dismissed flags are surfaced as `inactive` so they remain visible
 * in Epic's history without raising the banner. `entered-in-error`
 * is reserved for cases where CareBridge needs to retract a flag
 * after-the-fact — not the same as `dismissed` (which means the
 * clinician saw it and chose to ignore).
 */
export function mapFlagStatusToFhir(
  status: FlagStatus,
): "active" | "inactive" {
  if (status === "resolved" || status === "dismissed") return "inactive";
  return "active";
}

/**
 * Determine the end of the active period. Returns null when the flag
 * is still active.
 */
function periodEnd(
  flag: BuildFhirFlagArgs["flag"],
): string | null {
  if (flag.status === "resolved") return flag.resolved_at ?? null;
  if (flag.status === "dismissed") return flag.dismissed_at ?? null;
  return null;
}

/**
 * Build a FHIR R4 Flag resource ready to POST to Epic. The result
 * passes FHIR R4 schema validation against the
 * `http://hl7.org/fhir/StructureDefinition/Flag` profile (required
 * fields: status, code, subject).
 */
export function buildFhirFlag(args: BuildFhirFlagArgs): FhirFlag {
  const { flag } = args;
  const severityCoding = flagSeverityCoding(flag.severity);
  const status = mapFlagStatusToFhir(flag.status);
  const end = periodEnd(flag);

  const extension: FhirFlag["extension"] = [
    { url: RATIONALE_EXTENSION_URL, valueString: flag.rationale },
    { url: SUGGESTED_ACTION_EXTENSION_URL, valueString: flag.suggested_action },
  ];
  if (flag.rule_id) {
    extension.push({ url: RULE_ID_EXTENSION_URL, valueString: flag.rule_id });
  }

  const out: FhirFlag = {
    resourceType: "Flag",
    status,
    category: [
      {
        coding: [
          { system: FHIR_FLAG_CATEGORY_SYSTEM, code: "clinical" },
          {
            system: CAREBRIDGE_FLAG_CATEGORY_SYSTEM,
            code: flag.category,
            display: flag.category,
          },
        ],
      },
    ],
    code: {
      coding: [severityCoding],
      text: flag.summary,
    },
    subject: { reference: `Patient/${args.epicPatientFhirId}` },
    period: {
      start: flag.created_at,
      ...(end ? { end } : {}),
    },
    author: { reference: CAREBRIDGE_ORGANIZATION_REFERENCE },
    extension,
  };

  if (args.epicFlagId) {
    out.id = args.epicFlagId;
  }

  return out;
}
