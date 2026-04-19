/**
 * Single-drug + condition contraindication rules.
 *
 * These rules flag the combination of a single medication with a specific
 * comorbidity or lab value that makes continuation unsafe per FDA labeling,
 * package-insert contraindications, or strong society-guideline evidence.
 * They are mechanistically distinct from the multi-drug "cross-specialty"
 * risk patterns (QT+hypoK, triple-whammy AKI, thiazide+hypoK, etc.) that
 * live in `cross-specialty.ts`.
 *
 * Separation rationale (issue #904): contraindication rules each encode a
 * single drug-class ↔ condition interaction; cross-specialty rules encode
 * multi-drug combinations across specialties. Keeping them in separate
 * modules clarifies intent, shortens each file, and makes it obvious where
 * to add new rules of each type.
 *
 * Currently housed here:
 *   - CROSS-NSAID-CHF-001      — NSAID + congestive heart failure
 *   - CROSS-STATIN-HEPATIC-001 — Statin + severe hepatic impairment
 *   - CROSS-ACE-ARB-PREG-001   — ACE-I / ARB + pregnancy
 *   - CROSS-METFORMIN-GFR-001  — Metformin + eGFR < 30 (MALA risk)
 */

import type { FlagSeverity, FlagCategory, RuleFlag } from "@carebridge/shared-types";
import type { PatientContext } from "./cross-specialty.js";
import {
  ACE_ARB_PATTERN,
  PREGNANCY_ICD10_PATTERN,
  PREGNANCY_DESCRIPTION_PATTERN,
  STATIN_PATTERN,
} from "./cross-specialty.js";
import { METFORMIN_PATTERN, NSAID_PATTERN } from "./shared-drug-patterns.js";
import { getRecentEGFR } from "./lab-units.js";

// ─── CHF pattern helpers (used only by CROSS-NSAID-CHF-001) ─────────────

/**
 * Congestive heart failure diagnosis patterns.
 * ICD-10: I50.* (heart failure — all subtypes), I11.0 (hypertensive heart
 * disease with HF), I13.0 / I13.2 (hypertensive heart + CKD with HF).
 *
 * We deliberately match the full I50 family (HFrEF, HFpEF, acute, chronic,
 * systolic, diastolic, combined) because NSAIDs carry fluid-retention and
 * renal-perfusion risks across every CHF phenotype, not just reduced-EF.
 */
const CHF_ICD10_PATTERN = /^(I50(\.|$)|I11\.0|I13\.[02])/;

const CHF_DESCRIPTION_PATTERN =
  /\bchf\b|congestive heart failure|heart failure|cardiomyopathy|reduced ejection|systolic dysfunction|diastolic dysfunction|\bhfref\b|\bhfpef\b|\bhfmref\b|cardiac decompensation/i;

/**
 * Severe-CHF indicators. When any of these is present in the diagnosis
 * description the NSAID+CHF rule escalates from warning to critical, because
 * incremental renal-perfusion compromise in decompensated or advanced disease
 * can precipitate acute decompensation within days. An explicit EF <30% cue
 * in the description also qualifies as severe (most EHRs record EF in the
 * structured note or diagnosis text when it is clinically significant).
 */
const CHF_SEVERE_DESCRIPTION_PATTERN =
  /\bnyha (?:iii|iv|3|4)\b|class (?:iii|iv|3|4)|decompensated|advanced heart failure|end.?stage (?:cardiac|heart)|acute (?:heart failure|decompensation|on chronic)|ef\s*<\s*(?:30|25|20|15|10)|ejection fraction\s*(?:of\s*)?(?:<\s*)?(?:1\d|2\d|30)\s*%/i;

// ─── Severe hepatic pattern helpers (used only by CROSS-STATIN-HEPATIC-001) ──

/**
 * Severe hepatic-impairment descriptors. Broader statin-hepatic contraindication
 * (#237) applies specifically to severe hepatic disease — Child-Pugh C, acute
 * hepatic failure, decompensated cirrhosis, ALT/AST elevation >3x ULN. A
 * well-compensated chronic hepatitis B carrier on a low-dose statin does not
 * meet this rule; statins are only fully contraindicated once metabolic
 * reserve is impaired enough that routine hepatic clearance fails.
 *
 * We match on explicit severity cues in the description AND on the ICD-10
 * codes for hepatic failure (K72.*), acute/subacute liver failure, and
 * Child-Pugh C/decompensated cirrhosis cues.
 */
const SEVERE_HEPATIC_ICD10_PATTERN = /^K72(\.|$)/;

const SEVERE_HEPATIC_DESCRIPTION_PATTERN =
  /hepatic failure|liver failure|acute liver injury|fulminant hepat|decompensated (?:cirrhosis|liver|hepatic)|child.?pugh (?:c|b)|child pugh (?:c|b)|advanced (?:cirrhosis|liver disease)|end.?stage liver disease|\besld\b|hepatic encephalopathy|coagulopath.*hepat|ast\s*>\s*3x|alt\s*>\s*3x|transaminases?\s*>\s*3x|lft\s*>\s*3x ulN/i;

// ─── Rule type (mirrors cross-specialty.ts) ─────────────────────────────

interface ContraindicationRule {
  id: string;
  name: string;
  check: (ctx: PatientContext) => boolean;
  severity: FlagSeverity;
  category: FlagCategory;
  summary: string;
  rationale: string;
  /** Static suggested action; `buildSuggestedAction` takes precedence if set. */
  suggested_action?: string;
  buildSuggestedAction?: (ctx: PatientContext) => string;
  buildSeverity?: (ctx: PatientContext) => FlagSeverity;
  notify_specialties: string[];
}

const CONTRAINDICATION_RULES: ContraindicationRule[] = [
  {
    // CROSS-ACE-ARB-PREG-001 — ACE inhibitors and ARBs are known teratogens.
    // First-trimester exposure is associated with cardiovascular and CNS
    // malformations; second- and third-trimester exposure causes fetal
    // renal failure, oligohydramnios, pulmonary hypoplasia, skull
    // hypoplasia, and neonatal death (ACE inhibitor fetopathy). FDA labels
    // both classes as contraindicated in pregnancy (Category D historically;
    // equivalent current boxed warning). This complements the existing
    // Category X/D rules, which do NOT cover ACE/ARB.
    id: "CROSS-ACE-ARB-PREG-001",
    name: "Pregnancy + ACE inhibitor or ARB (teratogenic / fetopathic)",
    check: (ctx: PatientContext) => {
      const isPregnant =
        ctx.active_diagnosis_codes.some((code) =>
          PREGNANCY_ICD10_PATTERN.test(code),
        ) ||
        ctx.active_diagnoses.some((d) =>
          PREGNANCY_DESCRIPTION_PATTERN.test(d),
        );
      if (!isPregnant) return false;
      return ctx.active_medications.some((m) => ACE_ARB_PATTERN.test(m));
    },
    severity: "critical" as const,
    category: "medication-safety" as const,
    summary:
      "Pregnant patient on ACE inhibitor or ARB — contraindicated, risk of fetal renal failure and malformations",
    rationale:
      "ACE inhibitors and ARBs are contraindicated in all trimesters of pregnancy. First-trimester " +
      "exposure is associated with cardiovascular and CNS malformations. Second- and third-trimester " +
      "exposure causes ACE inhibitor fetopathy: fetal renal failure, oligohydramnios, pulmonary hypoplasia, " +
      "skull hypoplasia (membranous calvaria), limb contractures, hypotension, and neonatal death. Both " +
      "classes carry an FDA boxed warning. Safer alternatives for hypertension in pregnancy include " +
      "labetalol, nifedipine, and methyldopa.",
    suggested_action:
      "IMMEDIATE medication review required. Discontinue the ACE inhibitor or ARB and switch to a " +
      "pregnancy-safe antihypertensive (labetalol, nifedipine, or methyldopa). Consult obstetrics and " +
      "maternal-fetal medicine. Assess fetal exposure duration; if past 18 weeks, obtain an urgent " +
      "fetal ultrasound to evaluate amniotic fluid volume and renal anatomy.",
    notify_specialties: ["obstetrics", "cardiology", "pharmacology"],
  },
  {
    // CROSS-METFORMIN-GFR-001 — Metformin is contraindicated at eGFR < 30
    // mL/min/1.73m² per FDA labeling (2016 update) and ADA guidelines because
    // impaired renal clearance allows metformin accumulation, raising the risk
    // of life-threatening lactic acidosis (MALA — metformin-associated lactic
    // acidosis). Between eGFR 30–45 metformin can be continued at reduced
    // dose with monitoring, but below 30 it must be stopped. This rule is
    // complementary to DI-METFORMIN-CONTRAST (which addresses transient AKI
    // risk around contrast administration) and targets chronic/stable low
    // eGFR that is a hard contraindication.
    //
    // Units: eGFR in mL/min/1.73m². Threshold is strictly < 30 to mirror FDA
    // labeling exactly; eGFR = 30 does not fire.
    id: "CROSS-METFORMIN-GFR-001",
    name: "Metformin + eGFR < 30 (contraindicated, MALA risk)",
    check: (ctx: PatientContext) => {
      const onMetformin = ctx.active_medications.some((m) =>
        METFORMIN_PATTERN.test(m),
      );
      if (!onMetformin) return false;
      // Unit-aware eGFR lookup (#856). Refuses to match labs whose unit
      // is not numerically equivalent to mL/min/1.73m². An eGFR with an
      // unrecognized unit fails closed rather than silently comparing
      // against the 30 mL/min/1.73m² FDA threshold.
      const egfr = getRecentEGFR(ctx)?.value;
      if (egfr === undefined) return false;
      return egfr < 30;
    },
    severity: "critical" as const,
    category: "cross-specialty" as const,
    summary:
      "Patient on metformin with eGFR < 30 mL/min/1.73m² — contraindicated, risk of lactic acidosis",
    rationale:
      "Metformin is renally cleared unchanged; accumulation in advanced renal impairment drives mitochondrial " +
      "inhibition of gluconeogenesis and lactate oxidation, producing metformin-associated lactic acidosis " +
      "(MALA). MALA carries a mortality of 30–50%. FDA labeling (updated 2016) and ADA guidelines " +
      "contraindicate metformin at eGFR < 30 mL/min/1.73m². Between 30 and 45, metformin may be continued at " +
      "reduced dose with monitoring; below 30 it must be discontinued.",
    suggested_action:
      "Discontinue metformin. Switch to a renally-appropriate glycemic agent (e.g., DPP-4 inhibitor with " +
      "renal dose adjustment, insulin, or GLP-1 agonist per current eGFR). Assess for signs of lactic acidosis " +
      "(hyperventilation, malaise, nausea, non-specific abdominal pain); obtain venous blood gas and lactate " +
      "if any concern. Nephrology and endocrinology consultation recommended.",
    notify_specialties: ["nephrology", "endocrinology"],
  },
  {
    // CROSS-NSAID-CHF-001 — NSAIDs in heart failure produce sodium and fluid
    // retention (prostaglandin-mediated suppression of natriuresis) and
    // reduce renal perfusion. The ACC/AHA HF guideline and Beers Criteria
    // both flag NSAIDs as drugs to avoid in CHF regardless of ejection
    // fraction. Real-world observational data (Arfe 2016, BMJ) show a ~20%
    // relative increase in HF hospitalization within 2 weeks of NSAID
    // exposure.
    //
    // Severity: warning by default. Escalates to critical when the
    // diagnosis text signals severe/advanced disease (NYHA III-IV,
    // decompensated, acute, or EF <30) — those patients have minimal
    // compensatory reserve and an NSAID can precipitate acute
    // decompensation within days.
    id: "CROSS-NSAID-CHF-001",
    name: "NSAID in patient with congestive heart failure",
    check: (ctx: PatientContext) => {
      const hasCHF =
        ctx.active_diagnosis_codes.some((code) => CHF_ICD10_PATTERN.test(code)) ||
        ctx.active_diagnoses.some((d) => CHF_DESCRIPTION_PATTERN.test(d));
      if (!hasCHF) return false;
      return ctx.active_medications.some((m) => NSAID_PATTERN.test(m));
    },
    buildSeverity: (ctx: PatientContext) => {
      const hasSevere = ctx.active_diagnoses.some((d) =>
        CHF_SEVERE_DESCRIPTION_PATTERN.test(d),
      );
      return hasSevere ? "critical" : "warning";
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Patient with congestive heart failure is on an NSAID — risk of fluid retention and decompensation",
    rationale:
      "NSAIDs inhibit renal prostaglandin synthesis, causing sodium and water retention, blunting " +
      "diuretic response, and reducing renal perfusion. In CHF this precipitates volume overload, " +
      "hyperkalemia, and acute kidney injury. The ACC/AHA Heart Failure guideline classifies NSAIDs " +
      "as harmful (Class III) in all stages of HF. Observational data show a ~20% relative increase " +
      "in HF hospitalization within two weeks of NSAID initiation. Advanced disease (NYHA III-IV, " +
      "decompensated, acute HF, EF <30%) carries the highest risk and warrants critical escalation.",
    buildSuggestedAction: (ctx: PatientContext) => {
      const hasSevere = ctx.active_diagnoses.some((d) =>
        CHF_SEVERE_DESCRIPTION_PATTERN.test(d),
      );
      const base =
        "Discontinue the NSAID and switch to a cardiac-safe analgesic (acetaminophen first-line; topical " +
        "diclofenac for localized pain is reasonable because systemic absorption is low). Review volume " +
        "status, daily weights, and renal function; check BMP within 1 week if the NSAID has already been " +
        "taken for more than a few days.";
      if (hasSevere) {
        return (
          base +
          " Advanced / decompensated HF: obtain same-day BMP and BNP, assess for new edema or weight " +
          "gain, and consider hospital admission if any signs of acute decompensation are present."
        );
      }
      return base;
    },
    notify_specialties: ["cardiology"],
  },
  {
    // CROSS-STATIN-HEPATIC-001 — All statins undergo substantial hepatic
    // metabolism (CYP3A4 / CYP2C9) and their package inserts list active
    // liver disease or unexplained persistent elevations of hepatic
    // transaminases as contraindications. In severe hepatic impairment
    // (Child-Pugh C, decompensated cirrhosis, acute liver failure,
    // AST/ALT >3x ULN) clearance is reduced enough that statin exposure
    // can worsen hepatic injury and precipitate rhabdomyolysis from
    // supratherapeutic serum levels.
    //
    // This rule is deliberately broader than HEPATIC-HEPATOTOXIN-001
    // (which already fires on high-dose statins + any hepatic disease):
    // any statin at any dose is flagged when the hepatic disease is
    // severe. The two rules are complementary — HEPATIC-HEPATOTOXIN-001
    // covers the broad hepatotoxin set + moderate hepatic disease;
    // CROSS-STATIN-HEPATIC-001 catches the any-dose-severe edge.
    id: "CROSS-STATIN-HEPATIC-001",
    name: "Statin in patient with severe hepatic impairment",
    check: (ctx: PatientContext) => {
      const hasSevereHepatic =
        ctx.active_diagnosis_codes.some((code) =>
          SEVERE_HEPATIC_ICD10_PATTERN.test(code),
        ) ||
        ctx.active_diagnoses.some((d) =>
          SEVERE_HEPATIC_DESCRIPTION_PATTERN.test(d),
        );
      if (!hasSevereHepatic) return false;
      return ctx.active_medications.some((m) => STATIN_PATTERN.test(m));
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Patient with severe hepatic impairment is on a statin — contraindication per FDA labeling",
    rationale:
      "Statin package inserts list active liver disease or unexplained persistent transaminase " +
      "elevations as contraindications. In severe hepatic impairment (Child-Pugh C, decompensated " +
      "cirrhosis, acute liver failure, AST/ALT >3x ULN) reduced CYP3A4/CYP2C9 clearance produces " +
      "supratherapeutic systemic exposure, elevating risk of drug-induced liver injury and " +
      "rhabdomyolysis. Benefit on cardiovascular outcomes is unproven in this population while " +
      "incremental hepatic injury is a direct on-treatment harm.",
    suggested_action:
      "Hold the statin and consult hepatology. Obtain AST, ALT, total bilirubin, INR, albumin, and CK. " +
      "If lipid control is clinically essential (secondary prevention after recent MI), consider " +
      "bile-acid sequestrants (cholestyramine, colesevelam) or ezetimibe — both of which bypass " +
      "hepatic metabolism — after hepatology input. Do NOT resume the statin until LFTs stabilize " +
      "and the underlying hepatic process is adjudicated.",
    notify_specialties: ["hepatology", "cardiology"],
  },
];

/**
 * Evaluate all contraindication rules against the patient context and return
 * any flags that fire. Mirrors the shape of `checkCrossSpecialtyPatterns` so
 * the review-service can compose both lists without adapter layers.
 */
export function checkContraindications(
  patientContext: PatientContext,
): RuleFlag[] {
  const flags: RuleFlag[] = [];

  for (const rule of CONTRAINDICATION_RULES) {
    if (rule.check(patientContext)) {
      const suggestedAction = rule.buildSuggestedAction
        ? rule.buildSuggestedAction(patientContext)
        : rule.suggested_action;
      if (suggestedAction === undefined) {
        throw new Error(
          `Contraindication rule ${rule.id} is missing both suggested_action and buildSuggestedAction`,
        );
      }
      flags.push({
        severity: rule.buildSeverity ? rule.buildSeverity(patientContext) : rule.severity,
        category: rule.category,
        summary: rule.summary,
        rationale: rule.rationale,
        suggested_action: suggestedAction,
        notify_specialties: rule.notify_specialties,
        rule_id: rule.id,
      });
    }
  }

  return flags;
}
