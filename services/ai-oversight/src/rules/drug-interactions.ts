/**
 * Deterministic drug interaction checking.
 *
 * A curated list of high-severity drug interaction pairs. This is NOT a
 * comprehensive drug interaction database — it covers the most clinically
 * significant pairs that should fire immediately without waiting for LLM review.
 *
 * For comprehensive interaction checking, the LLM review layer considers the
 * full medication list in clinical context.
 */

import type { FlagSeverity, FlagCategory } from "@carebridge/shared-types";
import type { RuleFlag } from "./critical-values.js";

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
    id: "DI-QTC-COMBO",
    drugA: /amiodarone|sotalol|dofetilide|dronedarone|haloperidol|thioridazine/i,
    drugB: /azithromycin|zithromax|erythromycin|clarithromycin|ondansetron|zofran|methadone|levofloxacin|moxifloxacin/i,
    severity: "warning",
    summary: "Multiple QTc-prolonging agents: increased risk of torsades de pointes",
    rationale:
      "Concurrent use of multiple QTc-prolonging drugs has a synergistic effect on QT interval " +
      "prolongation, increasing the risk of torsades de pointes ventricular tachycardia, which can be fatal.",
    suggested_action:
      "Obtain baseline ECG and monitor QTc interval. Ensure electrolytes (K+, Mg2+) are within normal limits. Consider alternative agents.",
    notify_specialties: ["cardiology"],
  },
];

export function checkDrugInteractions(medications: string[]): RuleFlag[] {
  const flags: RuleFlag[] = [];
  const normalizedMeds = medications.map((m) => m.toLowerCase());

  for (const pair of INTERACTION_PAIRS) {
    let drugAMatch: string | null = null;
    let drugBMatch: string | null = null;

    for (const med of normalizedMeds) {
      if (pair.drugA.test(med) && !drugAMatch) {
        drugAMatch = med;
      }
      if (pair.drugB.test(med) && !drugBMatch) {
        drugBMatch = med;
      }
    }

    // Make sure they are different actual medications (avoid matching same med to both)
    if (drugAMatch && drugBMatch && drugAMatch !== drugBMatch) {
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
