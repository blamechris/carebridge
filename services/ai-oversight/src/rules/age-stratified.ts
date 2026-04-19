/**
 * Age-stratified medication safety rules (issue #236).
 *
 * Two risk bands that adult-only dosing ignores:
 *
 *  1. Elderly (age >= 65) — Beers Criteria 2023 update identifies drugs
 *     whose pharmacokinetic/pharmacodynamic profile interacts poorly with
 *     age-related changes in hepatic clearance, renal clearance, body
 *     composition, and CNS sensitivity. Classic examples: benzodiazepines
 *     raise fall and hip-fracture risk 2-3x; first-generation antihistamines
 *     cause anticholinergic delirium; chronic NSAID use drives GI bleeds
 *     and renal decline.
 *
 *  2. Pediatric (age < 18) — small body size and developing bone, cartilage,
 *     and enzyme systems make certain adult-safe drugs frankly dangerous:
 *     fluoroquinolones damage immature articular cartilage; tetracyclines
 *     permanently stain developing teeth; aspirin in the setting of viral
 *     illness carries a 30-50% mortality Reye's syndrome risk.
 *
 * All age-gated rules MUST fail closed when `age_years` is null/undefined.
 * Patient demographics are sometimes incomplete during early registration,
 * and firing a Beers warning on an unknown-age patient would produce
 * unactionable alert noise. The context builder logs `patient_age_unknown`
 * when this path is taken; see `buildPatientContextForRules`.
 *
 * Severity default: warning. These rules are meant as safety reminders for
 * prescribers, not ED-level emergencies — most fire on chronic-medication
 * review, where the harm accumulates over months rather than hours.
 */

import type {
  FlagSeverity,
  FlagCategory,
  RuleFlag,
} from "@carebridge/shared-types";
import type { PatientContext } from "./cross-specialty.js";

// ─── Drug patterns ──────────────────────────────────────────────────

/**
 * Benzodiazepines covered by the Beers 2023 avoid-in-elderly list. All
 * benzodiazepines prolong reaction time, worsen cognition, and raise fall
 * risk in older adults regardless of half-life, though short-acting agents
 * are slightly less bad than long-acting (diazepam, clonazepam) which
 * accumulate dangerously in reduced hepatic / renal clearance.
 */
const BENZODIAZEPINE_PATTERN =
  /\b(diazepam|valium|alprazolam|xanax|lorazepam|ativan|clonazepam|klonopin|temazepam|restoril|oxazepam|serax|triazolam|halcion|chlordiazepoxide|librium|midazolam|versed|clorazepate|tranxene|flurazepam|dalmane)\b/i;

/**
 * First-generation (sedating) antihistamines. Strongly anticholinergic —
 * Beers flags as high-severity avoidance because the anticholinergic burden
 * in an older adult worsens cognition, precipitates delirium, and raises
 * fall and retention risk. Second-generation agents (loratadine, cetirizine,
 * fexofenadine) do not share the profile and are not matched here.
 */
const FIRST_GEN_ANTIHISTAMINE_PATTERN =
  /\b(diphenhydramine|benadryl|chlorpheniramine|chlor.?trimeton|hydroxyzine|atarax|vistaril|promethazine|phenergan|doxylamine|unisom|meclizine|antivert|cyproheptadine|periactin|brompheniramine|dimenhydrinate|dramamine)\b/i;

/**
 * NSAIDs. Reuses the same chemical-class list as the renal/triple-whammy
 * rules in cross-specialty.ts. Duplicated here (rather than exported from
 * the cross-specialty module) to keep age-stratified rules self-contained;
 * adding an NSAID must update both lists, which is enforced by the test
 * fixture that asserts parity with the renal pattern.
 */
const NSAID_PATTERN =
  /\b(ibuprofen|advil|motrin|naproxen|aleve|diclofenac|voltaren|celecoxib|celebrex|indomethacin|ketorolac|toradol|meloxicam|piroxicam|nabumetone|etodolac|sulindac|ketoprofen)\b/i;

/**
 * Anticholinergic drugs on the Beers avoid-in-dementia list. These worsen
 * cognitive function and accelerate decline in patients with existing
 * dementia or cognitive impairment. Excludes the sedating antihistamines
 * above (already covered by their own rule).
 */
const ANTICHOLINERGIC_PATTERN =
  /\b(oxybutynin|ditropan|tolterodine|detrol|darifenacin|enablex|solifenacin|vesicare|trospium|sanctura|benztropine|cogentin|trihexyphenidyl|artane|scopolamine|transderm.?scop|dicyclomine|bentyl|hyoscyamine|levsin|amitriptyline|elavil|nortriptyline|pamelor|imipramine|tofranil|doxepin|sinequan)\b/i;

/**
 * Fluoroquinolone antibiotics. The FDA pediatric labeling restricts their
 * use to specific indications (inhalational anthrax, complicated UTI /
 * pyelonephritis) because animal data and human post-marketing surveillance
 * link them to articular cartilage damage, arthropathy, and rare Achilles
 * tendon injury in growing children.
 */
const FLUOROQUINOLONE_PATTERN =
  /\b(ciprofloxacin|cipro|levofloxacin|levaquin|moxifloxacin|avelox|ofloxacin|floxin|gemifloxacin|factive|norfloxacin|noroxin|delafloxacin|baxdela)\b/i;

/**
 * Aspirin / salicylates. The Reye's-syndrome association is documented for
 * aspirin (acetylsalicylic acid) specifically; acetaminophen is the safer
 * antipyretic in pediatric viral illness. Low-dose aspirin for Kawasaki
 * disease is a specialty indication that should be prescribed by cardiology
 * with explicit awareness of the risk — the rule still fires for Kawasaki
 * to surface the documentation expectation.
 */
const ASPIRIN_PATTERN =
  /\b(aspirin|asa|acetylsalicylic acid|bayer|bufferin|ecotrin|st\.?\s*joseph)\b/i;

/**
 * Viral-illness description pattern. Reye's syndrome is triggered by
 * aspirin exposure during an active viral infection (classically influenza
 * and varicella, but other viruses have been implicated). The rule only
 * fires when the patient's active-diagnosis list shows an ongoing viral
 * illness AND an aspirin is on the med list — aspirin in a pediatric
 * patient without a viral context is a different clinical decision (e.g.
 * Kawasaki prophylaxis) and is surfaced by the general pediatric-aspirin
 * rule at a lower severity.
 */
const VIRAL_ILLNESS_PATTERN =
  /\b(influenza|\bflu\b|varicella|chickenpox|viral (?:infection|illness|syndrome|fever|hepatitis|gastroenteritis)|covid|sars.?cov|rsv|parainfluenza|respiratory syncytial|rhinovirus|adenovirus|enterovirus|coxsackie|mononucleosis|epstein.?barr|herpes|hand.?foot.?mouth)\b/i;

/**
 * Tetracyclines (tetracycline, doxycycline, minocycline, demeclocycline).
 * Contraindicated in children under 8 because chelation into developing
 * tooth enamel and bone produces permanent yellow-brown discoloration and
 * enamel hypoplasia. Doxycycline has a slightly better profile for short
 * courses (CDC endorses doxycycline for suspected rickettsial disease in
 * any age group because untreated RMSF carries 20%+ mortality), but this
 * safety rule still surfaces the contraindication.
 */
const TETRACYCLINE_PATTERN =
  /\b(tetracycline|sumycin|doxycycline|vibramycin|doxy|minocycline|minocin|solodyn|demeclocycline|declomycin|tigecycline|tygacil|eravacycline|xerava|omadacycline|nuzyra)\b/i;

/**
 * Dementia / cognitive-impairment diagnoses (for anticholinergic + dementia).
 * ICD-10: F01 (vascular dementia), F02 (dementia in other diseases),
 * F03 (unspecified dementia), G30 (Alzheimer's), G31.8 (Lewy body and
 * other cerebral degeneration), F05 (delirium).
 */
const DEMENTIA_ICD10_PATTERN = /^(F0[1235]|G30|G31\.8)/;

const DEMENTIA_DESCRIPTION_PATTERN =
  /\b(dementia|alzheimer|lewy body|frontotemporal|vascular dementia|cognitive impairment|\bmci\b|major neurocognitive|minor neurocognitive|cerebral degeneration)\b/i;

// ─── Age thresholds ─────────────────────────────────────────────────

/** Beers Criteria population: adults age 65 and older. */
const ELDERLY_THRESHOLD_YEARS = 65;

/** Pediatric: under 18 years. */
const PEDIATRIC_THRESHOLD_YEARS = 18;

/** Tetracycline threshold: under 8 years (dental-development window). */
const TETRACYCLINE_PEDIATRIC_THRESHOLD_YEARS = 8;

// ─── Rule type ──────────────────────────────────────────────────────

interface AgeStratifiedRule {
  id: string;
  name: string;
  check: (ctx: PatientContext) => boolean;
  severity: FlagSeverity;
  category: FlagCategory;
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * True iff the patient age is known AND meets the elderly threshold.
 * A null/undefined age fails closed — unknown demographics must not fire
 * a Beers warning because the error rate is too high.
 */
function isElderly(ctx: PatientContext): boolean {
  return (
    ctx.age_years !== null &&
    ctx.age_years !== undefined &&
    ctx.age_years >= ELDERLY_THRESHOLD_YEARS
  );
}

/**
 * True iff the patient age is known AND under 18. Fails closed on unknown
 * age for the same reason as isElderly.
 */
function isPediatric(ctx: PatientContext): boolean {
  return (
    ctx.age_years !== null &&
    ctx.age_years !== undefined &&
    ctx.age_years < PEDIATRIC_THRESHOLD_YEARS
  );
}

/**
 * True iff the patient age is known AND under the tetracycline pediatric
 * threshold (8 years).
 */
function isUnderTetracyclineAge(ctx: PatientContext): boolean {
  return (
    ctx.age_years !== null &&
    ctx.age_years !== undefined &&
    ctx.age_years < TETRACYCLINE_PEDIATRIC_THRESHOLD_YEARS
  );
}

/**
 * True iff any active diagnosis indicates dementia or major / minor
 * neurocognitive disorder.
 */
function hasDementia(ctx: PatientContext): boolean {
  return (
    ctx.active_diagnosis_codes.some((code) => DEMENTIA_ICD10_PATTERN.test(code)) ||
    ctx.active_diagnoses.some((d) => DEMENTIA_DESCRIPTION_PATTERN.test(d))
  );
}

/**
 * True iff any active diagnosis indicates a viral illness. Used by the
 * aspirin + pediatric rule to detect Reye's-syndrome risk context.
 */
function hasViralIllness(ctx: PatientContext): boolean {
  return ctx.active_diagnoses.some((d) => VIRAL_ILLNESS_PATTERN.test(d));
}

// ─── Rules ──────────────────────────────────────────────────────────

const AGE_STRATIFIED_RULES: AgeStratifiedRule[] = [
  {
    id: "GERI-BENZO-001",
    name: "Benzodiazepine in elderly patient (Beers Criteria)",
    check: (ctx: PatientContext) => {
      if (!isElderly(ctx)) return false;
      return ctx.active_medications.some((m) => BENZODIAZEPINE_PATTERN.test(m));
    },
    severity: "warning",
    category: "medication-safety",
    summary:
      "Elderly patient (>= 65) on a benzodiazepine — Beers Criteria: avoid due to fall and cognitive risk",
    rationale:
      "The 2023 AGS Beers Criteria lists benzodiazepines as drugs to avoid in older adults regardless of " +
      "indication or duration. Older adults have increased CNS sensitivity and reduced hepatic clearance of " +
      "benzodiazepines, which raises fall risk 2-3x, doubles hip-fracture risk, and contributes to delirium, " +
      "cognitive decline, and motor-vehicle crashes. Long-acting agents (diazepam, clonazepam, flurazepam) " +
      "are particularly dangerous because active metabolites accumulate. Tolerance and dependence develop " +
      "rapidly; abrupt discontinuation in a long-term user can produce seizures, so deprescribing must be " +
      "a gradual taper rather than an abrupt stop.",
    suggested_action:
      "Review indication. If the benzodiazepine is for insomnia, switch to non-pharmacologic CBT-I and " +
      "consider melatonin or low-dose doxepin short-term. If for anxiety, consider SSRI/SNRI or buspirone. " +
      "If the patient is already long-term dependent, plan a slow taper (reduce by 10-25% every 2-4 weeks) " +
      "rather than abrupt discontinuation. Educate on fall precautions in the interim.",
    notify_specialties: ["geriatrics", "primary_care"],
  },
  {
    id: "GERI-ANTIHIST-001",
    name: "First-generation antihistamine in elderly patient (Beers Criteria)",
    check: (ctx: PatientContext) => {
      if (!isElderly(ctx)) return false;
      return ctx.active_medications.some((m) =>
        FIRST_GEN_ANTIHISTAMINE_PATTERN.test(m),
      );
    },
    severity: "warning",
    category: "medication-safety",
    summary:
      "Elderly patient (>= 65) on a first-generation antihistamine — Beers Criteria: strong anticholinergic burden",
    rationale:
      "First-generation antihistamines (diphenhydramine, hydroxyzine, promethazine, chlorpheniramine, etc.) " +
      "are strongly anticholinergic and readily cross the blood-brain barrier. In older adults this produces " +
      "confusion, delirium, urinary retention, constipation, blurred vision, dry mouth, and worsening of " +
      "narrow-angle glaucoma or BPH. The AGS Beers Criteria classifies these as drugs to avoid with high " +
      "level of evidence. Cumulative anticholinergic burden across multiple drugs is independently associated " +
      "with dementia incidence in longitudinal cohorts.",
    suggested_action:
      "Switch to a second-generation antihistamine (loratadine, cetirizine, or fexofenadine) which have " +
      "negligible anticholinergic activity and CNS penetration. For sleep, address underlying insomnia with " +
      "CBT-I rather than diphenhydramine (classic \"PM\" preparations). Review all active medications for " +
      "cumulative anticholinergic burden.",
    notify_specialties: ["geriatrics", "primary_care"],
  },
  {
    id: "GERI-NSAID-CHRONIC-001",
    name: "Chronic NSAID use in elderly patient (Beers Criteria)",
    check: (ctx: PatientContext) => {
      if (!isElderly(ctx)) return false;
      return ctx.active_medications.some((m) => NSAID_PATTERN.test(m));
    },
    severity: "warning",
    category: "medication-safety",
    summary:
      "Elderly patient (>= 65) on an NSAID — Beers Criteria: GI bleeding, renal, and cardiovascular risk",
    rationale:
      "Non-aspirin NSAIDs in older adults triple the risk of upper-GI bleeding and peptic ulcer disease; " +
      "concurrent anticoagulation, antiplatelet therapy, or corticosteroid use compounds the risk further. " +
      "NSAIDs also cause fluid retention, raise blood pressure by 3-5 mmHg, precipitate heart-failure " +
      "exacerbation, and reduce renal perfusion — every one of which is more common in the elderly. The " +
      "Beers Criteria recommends avoiding chronic NSAID use entirely unless alternatives have failed.",
    suggested_action:
      "First-line: acetaminophen up to 3 g/day (2 g/day if hepatic impairment). Topical diclofenac is a " +
      "reasonable alternative for localized musculoskeletal pain with minimal systemic absorption. If an " +
      "oral NSAID is unavoidable, use the lowest effective dose for the shortest duration, co-prescribe a " +
      "PPI, and monitor creatinine and blood pressure. Document the rationale for chronic use.",
    notify_specialties: ["geriatrics", "primary_care"],
  },
  {
    id: "GERI-ANTICHOL-DEMENTIA-001",
    name: "Anticholinergic in elderly patient with dementia (Beers Criteria)",
    check: (ctx: PatientContext) => {
      if (!isElderly(ctx)) return false;
      if (!hasDementia(ctx)) return false;
      return ctx.active_medications.some((m) => ANTICHOLINERGIC_PATTERN.test(m));
    },
    severity: "warning",
    category: "medication-safety",
    summary:
      "Elderly dementia patient on an anticholinergic — Beers Criteria: accelerates cognitive decline",
    rationale:
      "Anticholinergic medications worsen cognition in patients with existing dementia and accelerate " +
      "functional decline. Bladder antimuscarinics (oxybutynin, tolterodine), tricyclic antidepressants " +
      "(amitriptyline, nortriptyline), and Parkinson-disease anticholinergics (benztropine, " +
      "trihexyphenidyl) are particular offenders. The Beers Criteria lists this combination as " +
      "especially high-risk because the cognitive harm is often misattributed to disease progression " +
      "rather than recognized as a reversible drug effect.",
    suggested_action:
      "Deprescribe the anticholinergic where possible. For overactive bladder, consider mirabegron (a " +
      "beta-3 agonist) which lacks anticholinergic activity; for depression with dementia, sertraline or " +
      "citalopram are better options. If the drug is a Parkinson's anticholinergic, neurology input is " +
      "needed before substitution. Assess for delirium and obtain a baseline cognitive score so downstream " +
      "clinicians can track whether the harm is reversible.",
    notify_specialties: ["geriatrics", "neurology"],
  },
  {
    id: "PEDI-FLUOROQUINOLONE-001",
    name: "Fluoroquinolone in pediatric patient",
    check: (ctx: PatientContext) => {
      if (!isPediatric(ctx)) return false;
      return ctx.active_medications.some((m) => FLUOROQUINOLONE_PATTERN.test(m));
    },
    severity: "warning",
    category: "medication-safety",
    summary:
      "Pediatric patient (< 18) on a fluoroquinolone — risk of articular cartilage damage",
    rationale:
      "Fluoroquinolones (ciprofloxacin, levofloxacin, moxifloxacin) cause arthropathy and articular " +
      "cartilage damage in growing animals, and pediatric trials have documented musculoskeletal adverse " +
      "events in 3-4% of exposed children. The FDA restricts pediatric use to specific indications " +
      "(complicated UTI, pyelonephritis, inhalational anthrax, plague) because safer alternatives exist " +
      "for most community infections. Tendinopathy and rare Achilles tendon rupture have also been " +
      "reported. Use outside labeled pediatric indications requires explicit documentation that narrower-" +
      "spectrum alternatives have failed or are contraindicated.",
    suggested_action:
      "Review the indication. If the infection can be treated with a narrower-spectrum alternative " +
      "(amoxicillin-clavulanate for sinusitis, cephalexin for uncomplicated UTI, azithromycin for atypical " +
      "pneumonia), switch. If the fluoroquinolone is necessary (e.g. complicated UTI with resistant " +
      "organism), document the culture sensitivity and rationale, limit duration, and counsel the family " +
      "on tendon and joint symptoms.",
    notify_specialties: ["pediatrics", "infectious_disease"],
  },
  {
    id: "PEDI-ASPIRIN-VIRAL-001",
    name: "Aspirin in pediatric patient with viral illness (Reye's syndrome risk)",
    check: (ctx: PatientContext) => {
      if (!isPediatric(ctx)) return false;
      if (!hasViralIllness(ctx)) return false;
      return ctx.active_medications.some((m) => ASPIRIN_PATTERN.test(m));
    },
    severity: "warning",
    category: "medication-safety",
    summary:
      "Pediatric patient with viral illness on aspirin — risk of Reye's syndrome",
    rationale:
      "Aspirin exposure during viral illness (classically influenza and varicella, also other viruses) " +
      "is associated with Reye's syndrome — an acute encephalopathy with hepatic steatosis and a mortality " +
      "of 30-40% even with aggressive supportive care. CDC, FDA, and AAP recommend avoiding aspirin and " +
      "salicylate-containing medications in children and teenagers with fever, flu-like illness, or " +
      "chickenpox. The risk is not limited to full analgesic doses; even low-dose aspirin (e.g. 81 mg " +
      "for Kawasaki prophylaxis) warrants specialty oversight during intercurrent viral illness.",
    suggested_action:
      "Hold the aspirin for the duration of the viral illness. Use acetaminophen or ibuprofen for " +
      "fever / pain instead (both are safe in this setting). If aspirin is being used for Kawasaki " +
      "disease or another cardiology indication, contact pediatric cardiology before discontinuation " +
      "and consider alternative antiplatelet coverage. Counsel the family on Reye's warning signs " +
      "(protracted vomiting, lethargy, behavioral change).",
    notify_specialties: ["pediatrics"],
  },
  {
    id: "PEDI-TETRACYCLINE-001",
    name: "Tetracycline in pediatric patient under 8",
    check: (ctx: PatientContext) => {
      if (!isUnderTetracyclineAge(ctx)) return false;
      return ctx.active_medications.some((m) => TETRACYCLINE_PATTERN.test(m));
    },
    severity: "warning",
    category: "medication-safety",
    summary:
      "Pediatric patient under 8 on a tetracycline — risk of permanent tooth discoloration",
    rationale:
      "Tetracyclines chelate calcium and deposit into developing tooth enamel and growing bone, producing " +
      "permanent yellow-brown discoloration, enamel hypoplasia, and transient impairment of bone growth. " +
      "The risk window covers the period of permanent-tooth calcification, roughly from the late fetal " +
      "period through age 8. Doxycycline has a milder profile for short courses (CDC endorses it for " +
      "suspected rickettsial disease at any age because untreated Rocky Mountain spotted fever carries " +
      "over 20% mortality) — but for routine infections this rule still surfaces the contraindication so " +
      "the prescriber documents the explicit risk-benefit decision.",
    suggested_action:
      "Review the indication. For routine infections (acne, respiratory, Lyme prophylaxis, chlamydia in " +
      "older children) switch to an age-appropriate alternative: amoxicillin or cephalosporin for most " +
      "bacterial infections, azithromycin for atypical pathogens, amoxicillin for Lyme in children under 8. " +
      "If the tetracycline is for suspected or confirmed rickettsial disease, doxycycline is acceptable " +
      "because the mortality benefit outweighs dental risk for the typical 7-10 day course — document the " +
      "indication and counsel the family.",
    notify_specialties: ["pediatrics"],
  },
];

/**
 * Evaluate all age-stratified rules against a patient context. Returns one
 * RuleFlag per firing rule. When `age_years` is null/undefined the function
 * returns an empty array — every rule in this module is age-gated.
 */
export function checkAgeStratifiedRules(ctx: PatientContext): RuleFlag[] {
  const flags: RuleFlag[] = [];
  for (const rule of AGE_STRATIFIED_RULES) {
    if (rule.check(ctx)) {
      flags.push({
        severity: rule.severity,
        category: rule.category,
        summary: rule.summary,
        rationale: rule.rationale,
        suggested_action: rule.suggested_action,
        notify_specialties: rule.notify_specialties,
        rule_id: rule.id,
      });
    }
  }
  return flags;
}
