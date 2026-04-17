/**
 * Deterministic drug interaction checking.
 *
 * A curated list of high-severity drug interaction pairs. This is NOT a
 * comprehensive drug interaction database — it covers the most clinically
 * significant pairs that should fire immediately without waiting for LLM review.
 *
 * For comprehensive interaction checking, the LLM review layer considers the
 * full medication list in clinical context.
 *
 * QTc-prolonging drug list (DI-QTC-COMBO) is curated from:
 *   - CredibleMeds QTDrugs list (https://www.crediblemeds.org/healthcare-providers/drug-list)
 *     Known Risk and Possible Risk categories.
 *   - FDA labeling and FDA Drug Safety Communications for QT prolongation.
 *
 * Both regex groups (drugA, drugB) for DI-QTC-COMBO use the same pattern so
 * that any two distinct QT-prolonging agents — including intra-class pairs such
 * as two antipsychotics, or antipsychotic + fluoroquinolone — trigger the flag.
 */

import type { FlagSeverity, FlagCategory, RuleFlag } from "@carebridge/shared-types";

interface DrugInteractionPair {
  id: string;
  drugA: RegExp;
  drugB: RegExp;
  severity: FlagSeverity;
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

/**
 * Shared regex for QTc-prolonging drugs. Used by both drugA and drugB in the
 * DI-QTC-COMBO rule so the pattern is defined in exactly one place. Curated
 * from CredibleMeds QTDrugs (Known Risk + Possible Risk) and FDA labeling.
 */
const QTC_PATTERN =
  /amiodarone|pacerone|cordarone|sotalol|betapace|dofetilide|tikosyn|dronedarone|multaq|ibutilide|corvert|quinidine|procainamide|disopyramide|norpace|flecainide|tambocor|haloperidol|haldol|thioridazine|mellaril|chlorpromazine|thorazine|pimozide|orap|droperidol|quetiapine|seroquel|risperidone|risperdal|olanzapine|zyprexa|ziprasidone|geodon|aripiprazole|abilify|paliperidone|invega|iloperidone|fanapt|azithromycin|zithromax|erythromycin|clarithromycin|biaxin|levofloxacin|levaquin|moxifloxacin|avelox|ciprofloxacin|cipro|gemifloxacin|factive|ofloxacin|floxin|ondansetron|zofran|granisetron|kytril|dolasetron|anzemet|domperidone|motilium|hydroxychloroquine|plaquenil|chloroquine|aralen|quinine|methadone|dolophine|citalopram|celexa|escitalopram|lexapro|donepezil|aricept|amitriptyline|elavil|imipramine|tofranil|nortriptyline|pamelor|clomipramine|anafranil|sevoflurane|ultane|oxaliplatin|eloxatin|vandetanib|caprelsa|sunitinib|sutent|nilotinib|tasigna/i;

/**
 * Brand-to-generic normalization map for QTc-prolonging drugs.
 *
 * When deduplicating same-list regex matches (e.g. DI-QTC-COMBO), the matched
 * substring for a brand name ("pacerone") differs from the generic
 * ("amiodarone"), causing false-positive flags for the same underlying drug.
 * This map normalizes brand names to their generic equivalents before the
 * distinctness comparison.
 */
const BRAND_TO_GENERIC: Record<string, string> = {
  pacerone: "amiodarone",
  cordarone: "amiodarone",
  betapace: "sotalol",
  tikosyn: "dofetilide",
  multaq: "dronedarone",
  corvert: "ibutilide",
  norpace: "disopyramide",
  tambocor: "flecainide",
  haldol: "haloperidol",
  mellaril: "thioridazine",
  thorazine: "chlorpromazine",
  orap: "pimozide",
  seroquel: "quetiapine",
  risperdal: "risperidone",
  zyprexa: "olanzapine",
  geodon: "ziprasidone",
  abilify: "aripiprazole",
  invega: "paliperidone",
  fanapt: "iloperidone",
  zithromax: "azithromycin",
  biaxin: "clarithromycin",
  levaquin: "levofloxacin",
  avelox: "moxifloxacin",
  cipro: "ciprofloxacin",
  factive: "gemifloxacin",
  floxin: "ofloxacin",
  zofran: "ondansetron",
  kytril: "granisetron",
  anzemet: "dolasetron",
  motilium: "domperidone",
  plaquenil: "hydroxychloroquine",
  aralen: "chloroquine",
  dolophine: "methadone",
  celexa: "citalopram",
  lexapro: "escitalopram",
  aricept: "donepezil",
  elavil: "amitriptyline",
  tofranil: "imipramine",
  pamelor: "nortriptyline",
  anafranil: "clomipramine",
  ultane: "sevoflurane",
  eloxatin: "oxaliplatin",
  caprelsa: "vandetanib",
  sutent: "sunitinib",
  tasigna: "nilotinib",
};

/** Normalize a matched drug name through the brand-to-generic map. */
function normalizeToGeneric(matched: string): string {
  const lower = matched.toLowerCase();
  return BRAND_TO_GENERIC[lower] ?? lower;
}

const INTERACTION_PAIRS: DrugInteractionPair[] = [
  {
    id: "DI-WARFARIN-ASPIRIN",
    drugA: /warfarin|coumadin/i,
    drugB: /aspirin|asa\b/i,
    severity: "warning",
    summary: "Warfarin + Aspirin: increased bleeding risk",
    rationale:
      "Concurrent use of warfarin and aspirin significantly increases the risk of major bleeding events, " +
      "including gastrointestinal and intracranial hemorrhage. This combination may be intentional for " +
      "certain cardiac indications but requires close INR monitoring.",
    suggested_action:
      "Verify combination is intentional. Monitor INR closely. Consider PPI for GI prophylaxis.",
    notify_specialties: ["hematology"],
  },
  {
    id: "DI-WARFARIN-NSAID",
    drugA: /warfarin|coumadin/i,
    drugB: /ibuprofen|naproxen|diclofenac|celecoxib|indomethacin|ketorolac|meloxicam|piroxicam/i,
    severity: "critical",
    summary: "Warfarin + NSAID: high bleeding risk",
    rationale:
      "NSAIDs inhibit platelet function and can erode the gastric mucosa. Combined with warfarin's " +
      "anticoagulant effect, the risk of serious GI hemorrhage is markedly elevated. This combination " +
      "should be avoided whenever possible.",
    suggested_action:
      "Discontinue NSAID if possible. Use acetaminophen for pain. If NSAID required, add PPI and increase INR monitoring frequency.",
    notify_specialties: ["hematology"],
  },
  {
    id: "DI-METHOTREXATE-NSAID",
    drugA: /methotrexate|trexall/i,
    drugB: /ibuprofen|naproxen|diclofenac|celecoxib|indomethacin|ketorolac|meloxicam|piroxicam/i,
    severity: "critical",
    summary: "Methotrexate + NSAID: risk of methotrexate toxicity",
    rationale:
      "NSAIDs decrease renal clearance of methotrexate, leading to elevated methotrexate levels and " +
      "increased risk of bone marrow suppression, hepatotoxicity, and nephrotoxicity. This interaction " +
      "can be fatal at high methotrexate doses.",
    suggested_action:
      "Avoid NSAID if possible. If co-administration is necessary, monitor methotrexate levels, CBC, and renal function closely.",
    notify_specialties: ["oncology", "rheumatology"],
  },
  {
    id: "DI-ACE-POTASSIUM",
    drugA: /lisinopril|enalapril|ramipril|captopril|benazepril|fosinopril|quinapril|perindopril/i,
    drugB: /potassium chloride|k-dur|klor-con|potassium supplement|potassium citrate/i,
    severity: "warning",
    summary: "ACE inhibitor + potassium supplement: hyperkalemia risk",
    rationale:
      "ACE inhibitors reduce aldosterone secretion, decreasing potassium excretion. Adding exogenous " +
      "potassium increases the risk of life-threatening hyperkalemia, which can cause cardiac arrhythmias.",
    suggested_action:
      "Monitor serum potassium levels. Consider reducing or discontinuing potassium supplement. Check renal function.",
    notify_specialties: ["nephrology", "cardiology"],
  },
  {
    id: "DI-ACE-ARB",
    drugA: /lisinopril|enalapril|ramipril|captopril|benazepril|fosinopril|quinapril|perindopril/i,
    drugB: /losartan|valsartan|irbesartan|candesartan|olmesartan|telmisartan|azilsartan/i,
    severity: "warning",
    summary: "ACE inhibitor + ARB: dual RAAS blockade increases renal and hyperkalemia risk",
    rationale:
      "Dual RAAS blockade with ACE inhibitor and ARB provides no additional cardiovascular benefit " +
      "but significantly increases the risk of hyperkalemia, hypotension, and acute kidney injury.",
    suggested_action:
      "Discontinue one of the two agents. Dual RAAS blockade is not recommended by current guidelines.",
    notify_specialties: ["cardiology", "nephrology"],
  },
  {
    id: "DI-SSRI-MAOI",
    drugA: /fluoxetine|sertraline|paroxetine|citalopram|escitalopram|fluvoxamine|venlafaxine|duloxetine|desvenlafaxine/i,
    drugB: /phenelzine|nardil|tranylcypromine|parnate|selegiline|isocarboxazid|marplan|rasagiline|safinamide/i,
    severity: "critical",
    summary: "SSRI/SNRI + MAOI: serotonin syndrome risk (potentially fatal)",
    rationale:
      "Concurrent use of serotonergic agents and MAOIs can cause serotonin syndrome, a potentially " +
      "fatal condition characterized by hyperthermia, rigidity, myoclonus, autonomic instability, and " +
      "altered mental status. A washout period of at least 2 weeks (5 weeks for fluoxetine) is required.",
    suggested_action:
      "CONTRAINDICATED combination. Discontinue one agent immediately and observe for serotonin syndrome. Ensure adequate washout period before switching.",
    notify_specialties: ["psychiatry"],
  },
  {
    id: "DI-SEROTONIN-TRAMADOL",
    drugA: /fluoxetine|sertraline|paroxetine|citalopram|escitalopram|fluvoxamine|venlafaxine|duloxetine|desvenlafaxine/i,
    drugB: /tramadol|ultram/i,
    severity: "critical",
    summary: "SSRI/SNRI + Tramadol: serotonin syndrome risk",
    rationale:
      "Tramadol has serotonin-norepinephrine reuptake inhibitor activity in addition to its opioid effects. " +
      "Combined with SSRIs or SNRIs, the additive serotonergic activity significantly increases the risk of " +
      "serotonin syndrome — a potentially fatal toxidrome characterized by hyperthermia, rigidity, myoclonus, " +
      "and autonomic instability. This is a commonly encountered combination in patients with comorbid pain and depression.",
    suggested_action:
      "Avoid combination. Use a non-serotonergic analgesic (e.g., acetaminophen, non-tramadol opioid if needed). " +
      "If co-prescribing is unavoidable, use lowest effective doses and counsel patient on serotonin syndrome symptoms.",
    notify_specialties: ["psychiatry", "pain_management"],
  },
  {
    id: "DI-SEROTONIN-LINEZOLID",
    drugA: /fluoxetine|sertraline|paroxetine|citalopram|escitalopram|fluvoxamine|venlafaxine|duloxetine|desvenlafaxine/i,
    drugB: /linezolid|zyvox/i,
    severity: "critical",
    summary: "SSRI/SNRI + Linezolid: serotonin syndrome risk (MAOI activity)",
    rationale:
      "Linezolid is a reversible, nonselective MAO inhibitor. When combined with serotonergic antidepressants, " +
      "it can precipitate serotonin syndrome. This interaction is frequently missed because linezolid is prescribed " +
      "as an antibiotic rather than a psychiatric medication. Cases of fatal serotonin syndrome have been reported.",
    suggested_action:
      "CONTRAINDICATED combination. Use an alternative antibiotic (e.g., vancomycin, daptomycin) if possible. " +
      "If linezolid is essential, discontinue SSRI/SNRI and monitor closely for serotonin syndrome for 2 weeks (5 weeks for fluoxetine).",
    notify_specialties: ["psychiatry", "infectious_disease"],
  },
  {
    id: "DI-SEROTONIN-DEXTROMETHORPHAN",
    drugA: /fluoxetine|sertraline|paroxetine|citalopram|escitalopram|fluvoxamine|venlafaxine|duloxetine|desvenlafaxine/i,
    drugB: /dextromethorphan|robitussin|delsym/i,
    severity: "warning",
    summary: "SSRI/SNRI + Dextromethorphan: serotonin syndrome risk",
    rationale:
      "Dextromethorphan has serotonergic activity via sigma-1 receptor agonism and serotonin reuptake inhibition. " +
      "Combined with SSRIs/SNRIs, particularly CYP2D6 inhibitors like fluoxetine and paroxetine which also " +
      "increase dextromethorphan levels, the risk of serotonin syndrome is elevated.",
    suggested_action:
      "Advise patient to avoid OTC cough products containing dextromethorphan. Use non-serotonergic cough suppressant alternatives.",
    notify_specialties: ["psychiatry"],
  },
  {
    id: "DI-SEROTONIN-METHYLENE-BLUE",
    drugA: /fluoxetine|sertraline|paroxetine|citalopram|escitalopram|fluvoxamine|venlafaxine|duloxetine|desvenlafaxine/i,
    drugB: /methylene blue|methylthioninium/i,
    severity: "critical",
    summary: "SSRI/SNRI + Methylene blue: serotonin syndrome risk (potent MAO-A inhibitor)",
    rationale:
      "Intravenous methylene blue is a potent MAO-A inhibitor. When administered to patients on serotonergic " +
      "antidepressants, it can precipitate severe serotonin syndrome. Multiple fatalities have been reported. " +
      "This interaction is frequently missed in surgical and procedural settings.",
    suggested_action:
      "CONTRAINDICATED combination. Discontinue SSRI/SNRI before elective procedures requiring methylene blue. " +
      "In emergencies, use lowest dose and monitor intensively for serotonin syndrome.",
    notify_specialties: ["psychiatry", "anesthesiology"],
  },
  {
    id: "DI-DIGOXIN-AMIODARONE",
    drugA: /digoxin|lanoxin/i,
    drugB: /amiodarone|pacerone|cordarone/i,
    severity: "critical",
    summary: "Digoxin + Amiodarone: digoxin toxicity risk",
    rationale:
      "Amiodarone increases serum digoxin levels by 70-100% by reducing renal and non-renal clearance. " +
      "This can lead to digoxin toxicity with symptoms including nausea, visual changes, and potentially " +
      "life-threatening arrhythmias.",
    suggested_action:
      "Reduce digoxin dose by 50% when starting amiodarone. Monitor digoxin levels and ECG closely.",
    notify_specialties: ["cardiology"],
  },
  {
    id: "DI-STATIN-FIBRATE",
    drugA: /atorvastatin|simvastatin|rosuvastatin|pravastatin|lovastatin|fluvastatin|pitavastatin/i,
    drugB: /gemfibrozil|fenofibrate|tricor/i,
    severity: "warning",
    summary: "Statin + Fibrate: increased rhabdomyolysis risk",
    rationale:
      "Concurrent use of statins and fibrates (especially gemfibrozil) increases the risk of myopathy " +
      "and rhabdomyolysis. Gemfibrozil inhibits statin glucuronidation, raising statin levels significantly.",
    suggested_action:
      "If combination needed, fenofibrate is preferred over gemfibrozil. Monitor CK levels and educate patient on muscle pain symptoms.",
    notify_specialties: ["cardiology"],
  },
  {
    id: "DI-LITHIUM-NSAID",
    drugA: /lithium|lithobid|eskalith/i,
    drugB: /ibuprofen|naproxen|diclofenac|celecoxib|indomethacin|ketorolac|meloxicam|piroxicam/i,
    severity: "critical",
    summary: "Lithium + NSAID: lithium toxicity risk",
    rationale:
      "NSAIDs reduce renal lithium clearance by 12-66%, leading to elevated lithium levels. Lithium " +
      "toxicity can cause tremor, ataxia, renal failure, seizures, and cardiac arrhythmias.",
    suggested_action:
      "Avoid NSAID if possible. If required, monitor lithium levels closely and reduce lithium dose. Use acetaminophen as alternative.",
    notify_specialties: ["psychiatry", "nephrology"],
  },
  {
    id: "DI-THEOPHYLLINE-CIPRO",
    drugA: /theophylline|aminophylline/i,
    drugB: /ciprofloxacin|cipro|levofloxacin|norfloxacin/i,
    severity: "warning",
    summary: "Theophylline + Fluoroquinolone: theophylline toxicity risk",
    rationale:
      "Ciprofloxacin and other fluoroquinolones inhibit CYP1A2-mediated theophylline metabolism, " +
      "increasing theophylline levels. Toxicity can manifest as seizures, arrhythmias, and GI distress.",
    suggested_action:
      "Monitor theophylline levels. Consider reducing theophylline dose by 30-50% or using a non-interacting antibiotic.",
    notify_specialties: ["pulmonology"],
  },
  {
    id: "DI-CLOPIDOGREL-PPI",
    drugA: /clopidogrel|plavix/i,
    drugB: /omeprazole|prilosec|esomeprazole|nexium/i,
    severity: "warning",
    summary: "Clopidogrel + Omeprazole/Esomeprazole: reduced antiplatelet effect",
    rationale:
      "Omeprazole and esomeprazole inhibit CYP2C19, which is required to convert clopidogrel to its " +
      "active metabolite. This can reduce the antiplatelet effect and increase the risk of cardiovascular " +
      "events in patients requiring dual antiplatelet therapy.",
    suggested_action:
      "Switch to pantoprazole or famotidine, which have minimal CYP2C19 interaction.",
    notify_specialties: ["cardiology"],
  },
  {
    id: "DI-POTASSIUM-SPIRONOLACTONE",
    drugA: /potassium chloride|k-dur|klor-con|potassium supplement|potassium citrate/i,
    drugB: /spironolactone|aldactone|eplerenone|inspra/i,
    severity: "warning",
    summary: "Potassium supplement + potassium-sparing diuretic: hyperkalemia risk",
    rationale:
      "Potassium-sparing diuretics reduce potassium excretion. Exogenous potassium supplementation " +
      "on top of this can lead to dangerous hyperkalemia, particularly in patients with renal impairment.",
    suggested_action:
      "Monitor serum potassium levels frequently. Consider discontinuing potassium supplement.",
    notify_specialties: ["nephrology", "cardiology"],
  },
  {
    id: "DI-METFORMIN-CONTRAST",
    drugA: /metformin|glucophage/i,
    drugB: /contrast|iodinated/i,
    severity: "warning",
    summary: "Metformin + iodinated contrast: lactic acidosis risk",
    rationale:
      "Iodinated contrast can cause acute kidney injury, and metformin accumulation in renal impairment " +
      "can cause life-threatening lactic acidosis. Metformin should be held before and after contrast administration.",
    suggested_action:
      "Hold metformin 48 hours before and after contrast. Check renal function before restarting.",
    notify_specialties: ["radiology", "endocrinology"],
  },
  {
    id: "DI-WARFARIN-FLUCONAZOLE",
    drugA: /warfarin|coumadin/i,
    drugB: /fluconazole|diflucan|itraconazole|voriconazole|ketoconazole/i,
    severity: "critical",
    summary: "Warfarin + Azole antifungal: markedly increased bleeding risk",
    rationale:
      "Azole antifungals are potent CYP2C9 and CYP3A4 inhibitors, significantly increasing warfarin " +
      "levels. INR can rise rapidly and unpredictably, leading to severe hemorrhage.",
    suggested_action:
      "Reduce warfarin dose empirically. Check INR within 3-5 days and frequently thereafter. Consider alternative antifungal.",
    notify_specialties: ["hematology"],
  },
  {
    id: "DI-OPIOID-BENZO",
    drugA: /oxycodone|hydrocodone|morphine|fentanyl|codeine|tramadol|hydromorphone|methadone|oxymorphone/i,
    drugB: /diazepam|valium|lorazepam|ativan|alprazolam|xanax|clonazepam|klonopin|midazolam|temazepam/i,
    severity: "critical",
    summary: "Opioid + Benzodiazepine: life-threatening respiratory depression risk",
    rationale:
      "Concurrent use of opioids and benzodiazepines increases the risk of profound sedation, " +
      "respiratory depression, coma, and death. FDA black box warning applies to this combination.",
    suggested_action:
      "Avoid combination if possible. If co-prescribed, use lowest effective doses and shortest duration. Monitor respiratory status closely.",
    notify_specialties: ["pain_management"],
  },
  {
    id: "DI-SSRI-TRIPTAN",
    drugA: /fluoxetine|sertraline|paroxetine|citalopram|escitalopram|fluvoxamine|venlafaxine|duloxetine/i,
    drugB: /sumatriptan|imitrex|rizatriptan|maxalt|zolmitriptan|eletriptan|naratriptan|frovatriptan|almotriptan/i,
    severity: "warning",
    summary: "SSRI/SNRI + Triptan: serotonin syndrome risk",
    rationale:
      "Triptans are serotonin 5-HT1 agonists. Combined with SSRIs/SNRIs, there is a risk of serotonin " +
      "syndrome, although the clinical significance has been debated. FDA has issued an advisory for this combination.",
    suggested_action:
      "Educate patient on serotonin syndrome symptoms. Monitor for agitation, hyperthermia, tachycardia, and myoclonus. Consider alternative migraine therapy.",
    notify_specialties: ["neurology", "psychiatry"],
  },
  {
    id: "DI-SILDENAFIL-NITRATE",
    drugA: /sildenafil|viagra|tadalafil|cialis|vardenafil|levitra|avanafil/i,
    drugB: /nitroglycerin|isosorbide|nitrate|nitroprusside|amyl nitrite/i,
    severity: "critical",
    summary: "PDE5 inhibitor + Nitrate: life-threatening hypotension risk",
    rationale:
      "PDE5 inhibitors and nitrates both cause vasodilation via the nitric oxide-cGMP pathway. " +
      "Combined, they can cause severe, refractory hypotension that may be fatal. This combination is " +
      "absolutely contraindicated.",
    suggested_action:
      "CONTRAINDICATED combination. Do NOT administer together. Ensure at least 24 hours (48 hours for tadalafil) between PDE5 inhibitor and nitrate use.",
    notify_specialties: ["cardiology"],
  },
  {
    id: "DI-CLOZAPINE-CARBAMAZEPINE",
    drugA: /clozapine|clozaril/i,
    drugB: /carbamazepine|tegretol/i,
    severity: "critical",
    summary: "Clozapine + Carbamazepine: additive bone marrow suppression risk",
    rationale:
      "Both clozapine and carbamazepine carry independent risks of agranulocytosis. Combined use " +
      "is considered contraindicated due to the additive risk of life-threatening bone marrow suppression.",
    suggested_action:
      "CONTRAINDICATED combination. Switch to alternative anticonvulsant (e.g., valproate, lamotrigine). Monitor CBC with differential.",
    notify_specialties: ["psychiatry", "neurology"],
  },
  {
    id: "DI-TRIMETHOPRIM-ACE",
    drugA: /trimethoprim|bactrim|septra|sulfamethoxazole/i,
    drugB: /lisinopril|enalapril|ramipril|captopril|benazepril|spironolactone|aldactone|eplerenone/i,
    severity: "warning",
    summary: "Trimethoprim + ACE inhibitor/K-sparing diuretic: hyperkalemia risk",
    rationale:
      "Trimethoprim acts as a potassium-sparing diuretic in the distal tubule (similar to amiloride). " +
      "Combined with ACE inhibitors or potassium-sparing diuretics, it can cause clinically significant " +
      "hyperkalemia, particularly in elderly patients or those with renal impairment.",
    suggested_action:
      "Monitor potassium within 2-3 days of starting trimethoprim. Consider alternative antibiotic if hyperkalemia risk is high.",
    notify_specialties: ["nephrology"],
  },
  {
    id: "DI-MACROLIDE-STATIN-CRITICAL",
    drugA: /clarithromycin|erythromycin/i,
    drugB: /simvastatin|lovastatin/i,
    severity: "critical",
    summary:
      "Macrolide antibiotic + CYP3A4-metabolized statin: contraindicated — severe rhabdomyolysis risk",
    rationale:
      "Clarithromycin and erythromycin are potent CYP3A4 inhibitors that dramatically increase plasma " +
      "levels of simvastatin and lovastatin (3-4x elevation). This causes severe myopathy, " +
      "rhabdomyolysis, and acute kidney injury. This combination is contraindicated per FDA labeling.",
    suggested_action:
      "CONTRAINDICATED combination. Hold statin during macrolide course, switch to a non-CYP3A4-metabolized " +
      "statin (pravastatin, rosuvastatin), or use an alternative antibiotic (azithromycin, amoxicillin, doxycycline).",
    notify_specialties: ["cardiology", "infectious_disease"],
  },
  {
    id: "DI-MACROLIDE-STATIN-WARNING",
    drugA: /clarithromycin|erythromycin/i,
    drugB: /atorvastatin/i,
    severity: "warning",
    summary:
      "Macrolide antibiotic + atorvastatin: dose reduction needed — rhabdomyolysis risk via CYP3A4 inhibition",
    rationale:
      "Clarithromycin and erythromycin inhibit CYP3A4, raising atorvastatin plasma levels and increasing " +
      "the risk of myopathy and rhabdomyolysis. Atorvastatin is less affected than simvastatin/lovastatin " +
      "but the interaction is still clinically significant. Dose reduction is recommended.",
    suggested_action:
      "Reduce atorvastatin dose during macrolide course (max 20mg/day). Monitor for muscle pain, weakness, " +
      "and dark urine. Consider switching to pravastatin or rosuvastatin, or use an alternative antibiotic.",
    notify_specialties: ["cardiology", "infectious_disease"],
  },
  {
    id: "DI-ACE-KSPARING",
    drugA: /lisinopril|enalapril|ramipril|captopril|benazepril|fosinopril|quinapril|perindopril/i,
    drugB: /spironolactone|aldactone|eplerenone|inspra|amiloride|midamor|triamterene|dyrenium/i,
    severity: "warning",
    summary: "ACE inhibitor + potassium-sparing diuretic: hyperkalemia risk",
    rationale:
      "ACE inhibitors reduce aldosterone-mediated potassium excretion. Potassium-sparing diuretics " +
      "further impair potassium elimination. The combined effect significantly increases the risk of " +
      "life-threatening hyperkalemia, especially in patients with renal impairment or diabetes.",
    suggested_action:
      "Monitor serum potassium within 1 week of initiation and regularly thereafter. Check renal function. " +
      "Use lowest effective doses. Counsel patient to avoid high-potassium foods and salt substitutes.",
    notify_specialties: ["nephrology", "cardiology"],
  },
  {
    id: "DI-LITHIUM-ACE",
    drugA: /lithium|lithobid|eskalith/i,
    drugB: /lisinopril|enalapril|ramipril|captopril|benazepril|fosinopril|quinapril|perindopril/i,
    severity: "warning",
    summary: "Lithium + ACE inhibitor: lithium toxicity risk",
    rationale:
      "ACE inhibitors reduce renal blood flow and GFR, decreasing lithium clearance by up to 25-35%. " +
      "This leads to lithium accumulation and increased risk of toxicity, presenting as tremor, ataxia, " +
      "confusion, renal failure, seizures, and cardiac arrhythmias.",
    suggested_action:
      "Monitor lithium levels within 1 week of ACE inhibitor initiation and with dose changes. " +
      "Consider reducing lithium dose. Ensure adequate hydration. Use ARBs with similar caution.",
    notify_specialties: ["psychiatry", "nephrology"],
  },
  {
    id: "DI-FLUOROQUINOLONE-CORTICOSTEROID",
    drugA: /ciprofloxacin|cipro|levofloxacin|moxifloxacin|norfloxacin|ofloxacin|gemifloxacin/i,
    drugB: /prednisone|prednisolone|methylprednisolone|dexamethasone/i,
    severity: "warning",
    summary: "Fluoroquinolone + systemic corticosteroid: increased tendon rupture risk",
    rationale:
      "Fluoroquinolones carry an FDA black box warning for tendinitis and tendon rupture. Concurrent " +
      "systemic corticosteroid use further increases this risk, particularly for the Achilles tendon. " +
      "Risk is highest in patients over 60, organ transplant recipients, and those with renal impairment. " +
      "Matcher limited to systemic agents (prednisone, prednisolone, methylprednisolone, dexamethasone) " +
      "to avoid alert fatigue from inhaled/topical corticosteroids with minimal systemic exposure.",
    suggested_action:
      "Avoid combination when possible. If co-prescribed, counsel patient to discontinue fluoroquinolone " +
      "and seek medical attention at first sign of tendon pain or swelling. Consider alternative antibiotic.",
    notify_specialties: ["orthopedics", "infectious_disease"],
  },
  // DI-QTC-COMBO: any two distinct QT-prolonging agents.
  //
  // Drug set curated from CredibleMeds QTDrugs (Known Risk + Possible Risk)
  // and FDA labeling. Both drugA and drugB reference the shared QTC_PATTERN
  // so that any pair of distinct QT-prolongers — including intra-class
  // combinations like two antipsychotics, or antipsychotic + fluoroquinolone
  // — is caught without duplicating the regex.
  //
  // Class coverage:
  //   - Class IA antiarrhythmics: quinidine, procainamide, disopyramide
  //   - Class IC antiarrhythmics: flecainide
  //   - Class III antiarrhythmics: amiodarone, sotalol, dofetilide, dronedarone, ibutilide
  //   - First-gen antipsychotics: haloperidol, thioridazine, chlorpromazine, pimozide, droperidol
  //   - Second-gen antipsychotics: quetiapine, risperidone, olanzapine, ziprasidone,
  //     aripiprazole, paliperidone, iloperidone
  //   - Macrolides: azithromycin, erythromycin, clarithromycin
  //   - Fluoroquinolones: levofloxacin, moxifloxacin, ciprofloxacin, gemifloxacin, ofloxacin
  //   - Antiemetics: ondansetron, granisetron, dolasetron, domperidone
  //   - Antimalarials: hydroxychloroquine, chloroquine, quinine
  //   - Opioids: methadone
  //   - SSRIs with documented QT risk: citalopram, escitalopram
  //   - Cholinesterase inhibitors: donepezil
  //   - TCAs: amitriptyline, imipramine, nortriptyline, clomipramine
  //   - Other: sevoflurane, oxaliplatin, vandetanib, sunitinib, nilotinib
  //
  // Brand names included where commonly prescribed (e.g., zithromax, zofran,
  // pacerone, cordarone, seroquel, risperdal, zyprexa, geodon, abilify).
  {
    id: "DI-QTC-COMBO",
    drugA: QTC_PATTERN,
    drugB: QTC_PATTERN,
    severity: "warning",
    summary:
      "Multiple QTc-prolonging agents: increased risk of torsades de pointes",
    rationale:
      "Concurrent use of multiple QTc-prolonging drugs has a synergistic effect on QT interval " +
      "prolongation, increasing the risk of torsades de pointes ventricular tachycardia, which can be fatal. " +
      "Risk is amplified by hypokalemia, hypomagnesemia, bradycardia, heart failure, and hepatic/renal impairment. " +
      "Drug list curated from CredibleMeds QTDrugs (Known Risk and Possible Risk) and FDA labeling.",
    suggested_action:
      "Obtain baseline ECG and monitor QTc interval. Ensure electrolytes (K+, Mg2+) are within normal limits. Consider alternative agents.",
    notify_specialties: ["cardiology"],
  },
];

export function checkDrugInteractions(medications: string[]): RuleFlag[] {
  const flags: RuleFlag[] = [];
  const normalizedMeds = medications.map((m) => m.toLowerCase());

  for (const pair of INTERACTION_PAIRS) {
    // When drugA and drugB reference the same regex (e.g. DI-QTC-COMBO, where
    // we want to catch any two distinct drugs from a single class list),
    // we need two medications at *different indices* that both match the
    // pattern.  Comparing by index (not string value) prevents a false-
    // positive when the same drug appears twice in the medication list and
    // also prevents a miss when two genuinely different drugs happen to
    // normalize to the same string.
    const sameList = pair.drugA === pair.drugB;

    let drugAIdx = -1;
    let drugBIdx = -1;

    if (sameList) {
      for (let i = 0; i < normalizedMeds.length; i++) {
        if (!pair.drugA.test(normalizedMeds[i])) continue;
        if (drugAIdx < 0) {
          drugAIdx = i;
        } else if (i !== drugAIdx) {
          drugBIdx = i;
          break;
        }
      }
    } else {
      for (let i = 0; i < normalizedMeds.length; i++) {
        if (pair.drugA.test(normalizedMeds[i]) && drugAIdx < 0) {
          drugAIdx = i;
        }
        if (pair.drugB.test(normalizedMeds[i]) && drugBIdx < 0) {
          drugBIdx = i;
        }
      }
    }

    // Ensure both sides matched and they refer to different medication
    // entries (by index).  For same-list rules (e.g. DI-QTC-COMBO) we also
    // need to verify the *matched drug name* differs — not just the full
    // medication string — so that "amiodarone 200mg" + "amiodarone 400mg"
    // (same drug, different dose) does not fire a false flag.
    let distinctDrugs = false;
    if (drugAIdx >= 0 && drugBIdx >= 0 && drugAIdx !== drugBIdx) {
      if (sameList) {
        const matchA = normalizedMeds[drugAIdx].match(pair.drugA);
        const matchB = normalizedMeds[drugBIdx].match(pair.drugB);
        distinctDrugs =
          matchA != null &&
          matchB != null &&
          normalizeToGeneric(matchA[0]) !== normalizeToGeneric(matchB[0]);
      } else {
        distinctDrugs =
          normalizedMeds[drugAIdx] !== normalizedMeds[drugBIdx];
      }
    }

    if (distinctDrugs) {
      flags.push({
        severity: pair.severity,
        category: "drug-interaction" as FlagCategory,
        summary: pair.summary,
        rationale: pair.rationale,
        suggested_action: pair.suggested_action,
        notify_specialties: pair.notify_specialties,
        rule_id: pair.id,
      });
    }
  }

  return flags;
}
