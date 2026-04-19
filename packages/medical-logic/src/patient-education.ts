/**
 * Patient-facing educational content (issue #328).
 *
 * Static reference data that maps ICD-10 diagnosis prefixes and generic
 * medication names to plain-language explanations. The content is written
 * for a non-clinical reader (target reading level ~8th grade) and is NOT
 * medical advice — the `when_to_contact_provider` field always directs
 * the patient back to their clinical team for anything specific.
 *
 * Structure is kept deliberately flat (no CMS, no generation, no per-
 * request API call) so:
 *   - The patient portal can render content offline and without a loading
 *     spinner on the education strip.
 *   - Updates flow through normal PRs with clinical review in the diff.
 *   - Tests can lock invariants (every entry has every field, prose has
 *     no clinical jargon above the 8th-grade band) without flakiness.
 *
 * Not in scope here:
 *   - Generated content (LLM per-request) — reserved for a follow-up
 *     when we want condition-plus-medication combination summaries.
 *   - Localisation — English only for now; the data shape is ready for a
 *     locale key when a translated content set lands.
 */

export interface EducationContent {
  title: string;
  /** One or two sentences: what the condition/medication is in plain language. */
  summary: string;
  /** Concrete self-care / day-to-day guidance. Each item a short sentence. */
  self_care: string[];
  /**
   * Signs that mean "call your care team" or "go to the ER". The portal
   * surfaces this prominently so a patient sees it without scrolling past
   * background reading first.
   */
  when_to_contact_provider: string[];
  /**
   * Optional curated external references. Kept short; patient education
   * works best with a few authoritative links (Medline, CDC, AHA) rather
   * than a list of 20.
   */
  links?: { label: string; url: string }[];
}

// ── Diagnosis content, keyed by ICD-10 prefix ───────────────────

/**
 * ICD-10 prefixes are matched in descending length order so a more
 * specific code wins over a broader family. For example, `I25.10`
 * (CAD without angina) matches the `I25` entry; `I63` would match a
 * dedicated stroke entry before falling through to a broader I-chapter
 * catch-all.
 */
const DIAGNOSIS_CONTENT: Record<string, EducationContent> = {
  // Endocrine / metabolic
  E11: {
    title: "Type 2 Diabetes",
    summary:
      "Type 2 diabetes means your body has trouble using insulin, so sugar builds up in your blood. Over time, high blood sugar can damage your heart, eyes, kidneys, and nerves — but daily habits can keep that from happening.",
    self_care: [
      "Check your blood sugar the way your care team asked you to, and keep a simple log.",
      "Eat regular meals with vegetables, lean protein, and whole grains; limit sugary drinks.",
      "Move your body for at least 30 minutes most days — even a walk counts.",
      "Take your medicine every day, even when you feel fine.",
    ],
    when_to_contact_provider: [
      "Blood sugar below 70 mg/dL or above 300 mg/dL.",
      "New numbness, tingling, or sores on your feet that won't heal.",
      "Blurred vision, chest pain, or trouble breathing — call 911.",
    ],
  },
  E10: {
    title: "Type 1 Diabetes",
    summary:
      "Type 1 diabetes means your body does not make insulin, so you need insulin every day to keep your blood sugar safe. With good habits and your insulin plan, you can live a full active life.",
    self_care: [
      "Follow your insulin schedule exactly — don't skip doses, even when sick.",
      "Check blood sugar before meals and before bed.",
      "Carry fast sugar (glucose tabs, juice) in case of a low.",
      "Wear medical ID so responders know you have diabetes if you can't speak.",
    ],
    when_to_contact_provider: [
      "Blood sugar above 250 mg/dL with ketones, nausea, or vomiting — call your care team the same day.",
      "Low blood sugar episodes you can't explain or that happen repeatedly.",
      "Confusion, trouble staying awake, or seizures — call 911.",
    ],
  },

  // Cardiovascular
  I10: {
    title: "High Blood Pressure (Hypertension)",
    summary:
      "High blood pressure means your heart is working harder than it should to push blood through your body. It usually has no symptoms, but over time it raises the risk of stroke, heart attack, and kidney problems.",
    self_care: [
      "Check your blood pressure at home and write the numbers down — bring the log to visits.",
      "Cut back on salt; aim for under 1 teaspoon a day total.",
      "Move your body for 30 minutes most days.",
      "Take your blood pressure medicine at the same time each day.",
    ],
    when_to_contact_provider: [
      "Blood pressure above 180/120 on two readings 5 minutes apart — call your care team now.",
      "Chest pain, severe headache, trouble seeing, or trouble speaking — call 911.",
    ],
  },
  I48: {
    title: "Atrial Fibrillation",
    summary:
      "Atrial fibrillation (AFib) is an irregular heartbeat. It can make you feel flutters or shortness of breath, and it raises the risk of stroke, which is why many people with AFib take a blood thinner.",
    self_care: [
      "Take your blood thinner exactly as prescribed — never skip or double up.",
      "Avoid sudden increases in alcohol or caffeine, which can trigger AFib.",
      "Tell every dentist, surgeon, and pharmacist that you take a blood thinner.",
    ],
    when_to_contact_provider: [
      "Sudden face drooping, arm weakness, slurred speech — call 911 (signs of stroke).",
      "Bleeding that won't stop, blood in stool or urine, or severe bruising.",
      "Fainting, chest pain, or heartbeat over 130 at rest.",
    ],
  },
  I50: {
    title: "Heart Failure",
    summary:
      "Heart failure means your heart can't pump as well as it should. The name sounds scary, but most people with it live for years by following a low-salt plan, taking their medicines, and watching their weight.",
    self_care: [
      "Weigh yourself every morning after the bathroom, before eating or drinking; keep a log.",
      "Keep salt below 2,000 mg (2 g) a day — read labels carefully.",
      "Limit fluids if your care team gave you a daily amount.",
      "Take all heart-failure medicines every day, even when you feel well.",
    ],
    when_to_contact_provider: [
      "Weight gain of 2+ lbs overnight or 5+ lbs in a week — call your care team.",
      "New shortness of breath lying flat, or needing extra pillows to sleep.",
      "Swelling in both legs that is new or worse than usual.",
    ],
  },

  // Venous thromboembolism
  I26: {
    title: "Pulmonary Embolism",
    summary:
      "A pulmonary embolism is a blood clot in the lung. It's serious, but it's treatable with a blood thinner. Most people recover fully; your care team will follow you closely for months.",
    self_care: [
      "Take your blood thinner exactly as prescribed and never miss a dose.",
      "Walk as much as you can — movement helps prevent new clots.",
      "Avoid long periods of sitting; on long trips, get up every 1–2 hours.",
    ],
    when_to_contact_provider: [
      "Chest pain, sudden shortness of breath, or coughing up blood — call 911.",
      "Swelling, pain, or red streaks in a leg (could be a new clot).",
      "Nose or gum bleeding that doesn't stop, or blood in urine or stool.",
    ],
  },
  I80: {
    title: "Blood Clot in a Vein (DVT)",
    summary:
      "A deep vein thrombosis (DVT) is a blood clot, usually in a leg. The clot can grow or travel to the lungs, so you'll be on a blood thinner until your care team says you can stop.",
    self_care: [
      "Take your blood thinner on schedule; set phone reminders if you need to.",
      "Walk regularly — gentle movement helps healing.",
      "Use compression stockings if your care team prescribed them.",
    ],
    when_to_contact_provider: [
      "Sudden trouble breathing or chest pain — call 911.",
      "New leg swelling, warmth, or red streaks above the clot.",
      "Bruising or bleeding you can't easily stop.",
    ],
  },

  // Respiratory
  J45: {
    title: "Asthma",
    summary:
      "Asthma is a long-term condition where your airways can tighten and swell, making it hard to breathe. Most asthma can be well controlled with the right inhaler plan.",
    self_care: [
      "Use your controller inhaler every day, even when you feel fine.",
      "Keep your rescue inhaler with you at all times.",
      "Know your triggers (smoke, pets, pollen) and avoid them when you can.",
      "Learn your action plan's green / yellow / red zones.",
    ],
    when_to_contact_provider: [
      "Rescue inhaler not helping, or using it more than 2 times a week outside exercise.",
      "Lips or fingertips turning blue, trouble speaking a full sentence — call 911.",
    ],
  },
  J44: {
    title: "COPD (Chronic Obstructive Pulmonary Disease)",
    summary:
      "COPD is long-term lung damage that makes it harder to breathe. You can't undo the damage, but you can keep it from getting worse by taking your inhalers, avoiding smoke, and exercising your lungs.",
    self_care: [
      "Take your inhalers in the right order your care team showed you.",
      "Stay away from cigarette smoke (yours or anyone else's).",
      "Get your flu and pneumonia vaccines every year.",
      "Do pulmonary rehab if offered — people who do it breathe easier.",
    ],
    when_to_contact_provider: [
      "More shortness of breath than usual, or new green / yellow mucus.",
      "Fever above 101°F or confusion — call your care team the same day.",
      "Severe trouble breathing, lips turning blue — call 911.",
    ],
  },

  // Mental health
  F32: {
    title: "Depression",
    summary:
      "Depression is a medical condition, not a weakness. It often gets better with therapy, medicine, or both. Reaching out for help is the most important step.",
    self_care: [
      "Keep regular sleep, meals, and a little daily movement.",
      "Stay connected — even a short text to a friend counts.",
      "If you were prescribed an antidepressant, take it daily; they take 4–6 weeks to fully work.",
    ],
    when_to_contact_provider: [
      "Thoughts of hurting yourself or others — call 988 (Suicide & Crisis Lifeline) or 911.",
      "New or worsening anxiety, sleep trouble, or side effects.",
    ],
  },
  F41: {
    title: "Anxiety",
    summary:
      "Anxiety is your body's alarm system working overtime. Therapy, medicine, and day-to-day habits can all help turn the volume down.",
    self_care: [
      "Practice slow breathing (in 4, hold 4, out 6) when you notice tension building.",
      "Limit caffeine and alcohol — both worsen anxiety.",
      "Try 20 minutes of movement daily; it's as effective as some medicines for mild anxiety.",
    ],
    when_to_contact_provider: [
      "Panic attacks that interrupt your day or sleep for over a week.",
      "Thoughts of harming yourself — call 988 or 911.",
    ],
  },

  // Renal
  N18: {
    title: "Chronic Kidney Disease",
    summary:
      "Chronic kidney disease means your kidneys aren't filtering waste as well as they should. With diet changes and careful medication choices, many people stay stable for years.",
    self_care: [
      "Keep blood pressure and blood sugar at the targets your care team sets.",
      "Ask before any new medicine — some (NSAIDs like ibuprofen) can hurt kidneys.",
      "Follow the salt / protein / potassium plan your nutritionist gave you.",
      "Drink the amount of water your care team recommends — more is not always better.",
    ],
    when_to_contact_provider: [
      "Swelling in legs, face, or hands that is new or worsening.",
      "Less urine than usual, or urine that is pink or red.",
      "Confusion, nausea, or extreme tiredness — call the same day.",
    ],
  },
};

// ── Medication content, keyed by lowercase generic name ─────────

const MEDICATION_CONTENT: Record<string, EducationContent> = {
  warfarin: {
    title: "Warfarin (Coumadin)",
    summary:
      "Warfarin is a blood thinner that helps prevent dangerous blood clots. Because it works differently in every body, you'll need regular blood tests (INR) to keep the dose right.",
    self_care: [
      "Take warfarin at the same time each day — most people take it in the evening.",
      "Keep your vitamin K intake (leafy greens) steady day to day; don't start or stop large amounts suddenly.",
      "Tell every doctor, dentist, and pharmacist you take warfarin before any procedure.",
      "Use a soft toothbrush and an electric razor to reduce bleeding risk.",
    ],
    when_to_contact_provider: [
      "Nose or gum bleeding that doesn't stop in 10 minutes.",
      "Red or black stool, blood in urine, bruising without bumping into anything.",
      "Bad headache with confusion — call 911.",
    ],
  },
  apixaban: {
    title: "Apixaban (Eliquis)",
    summary:
      "Apixaban is a blood thinner that helps prevent strokes and clots. Unlike warfarin, it does not need regular blood tests.",
    self_care: [
      "Take it twice a day, 12 hours apart, with or without food.",
      "Never skip or double-dose if you miss one — take it as soon as you remember, but never two in one time slot.",
      "Tell every clinician you take a blood thinner before any procedure.",
    ],
    when_to_contact_provider: [
      "Bleeding that won't stop, or blood in stool / urine.",
      "Sudden weakness, slurred speech, vision change — call 911 (stroke signs).",
    ],
  },
  metformin: {
    title: "Metformin",
    summary:
      "Metformin helps your body use insulin better and lowers blood sugar. It's the most-prescribed first medicine for type 2 diabetes.",
    self_care: [
      "Take it with food to reduce stomach upset.",
      "Start low and go slow — nausea usually fades in 1–2 weeks.",
      "Keep regular lab checks of kidney function as your care team asks.",
    ],
    when_to_contact_provider: [
      "Unusual muscle aches, rapid breathing, or feeling very weak — stop the pill and call now (rare lactic acidosis risk).",
      "Kidney test results change — your dose may need adjustment.",
    ],
  },
  lisinopril: {
    title: "Lisinopril",
    summary:
      "Lisinopril lowers blood pressure and protects the heart and kidneys. A dry cough is a common side effect; if it bothers you, there are similar medicines without the cough.",
    self_care: [
      "Take it at the same time every day, with or without food.",
      "Stand up slowly the first week — it can cause lightheadedness at first.",
      "Avoid potassium salt substitutes unless your care team says they're OK.",
    ],
    when_to_contact_provider: [
      "Swelling of lips, tongue, or throat — stop the pill and call 911 (rare angioedema).",
      "Persistent dry cough lasting over 2 weeks.",
      "Dizziness when standing that doesn't go away.",
    ],
  },
  atorvastatin: {
    title: "Atorvastatin (Lipitor)",
    summary:
      "Atorvastatin lowers cholesterol and protects against heart attack and stroke. It works best taken every day long-term.",
    self_care: [
      "Take it in the evening (your body makes more cholesterol at night).",
      "Avoid large amounts of grapefruit juice — it raises drug levels.",
      "Keep up a heart-healthy diet even on the medicine.",
    ],
    when_to_contact_provider: [
      "Unusual muscle pain, weakness, or dark urine (rare rhabdomyolysis).",
      "Yellow skin or eyes, or severe belly pain.",
    ],
  },
  aspirin: {
    title: "Aspirin (low-dose, 81 mg)",
    summary:
      "Low-dose aspirin thins the blood slightly to help prevent heart attacks and strokes in people at high risk. It's only 'preventive' for some patients — don't start it on your own.",
    self_care: [
      "Take with food to reduce stomach upset.",
      "Never take extra aspirin for pain without checking — doubling the dose doubles bleeding risk.",
    ],
    when_to_contact_provider: [
      "Black or red stool, coffee-ground vomit, or severe stomach pain.",
      "Nosebleeds that won't stop in 15 minutes.",
    ],
  },
  omeprazole: {
    title: "Omeprazole",
    summary:
      "Omeprazole lowers stomach acid to heal ulcers and calm reflux. Most people take it for 4–8 weeks, then reassess.",
    self_care: [
      "Take it 30–60 minutes before the first meal of the day.",
      "Don't crush or chew the capsule; swallow it whole.",
    ],
    when_to_contact_provider: [
      "Reflux that doesn't improve in 2 weeks.",
      "Trouble swallowing, unintended weight loss, or vomiting blood.",
    ],
  },
  levothyroxine: {
    title: "Levothyroxine",
    summary:
      "Levothyroxine replaces thyroid hormone when your thyroid isn't making enough. The right dose is very specific — small changes matter.",
    self_care: [
      "Take it on an empty stomach, first thing in the morning, with water only. Wait 30–60 minutes before coffee or food.",
      "Don't switch between brand and generic — the small dose differences add up.",
      "Keep calcium, iron, and antacids 4 hours apart from the pill.",
    ],
    when_to_contact_provider: [
      "Heart racing, tremor, or losing weight quickly — your dose may be too high.",
      "Unusual tiredness or weight gain — your dose may be too low.",
    ],
  },
  sertraline: {
    title: "Sertraline (Zoloft)",
    summary:
      "Sertraline is an antidepressant that also helps anxiety, OCD, and PTSD. It usually takes 4–6 weeks to reach its full effect.",
    self_care: [
      "Take it at the same time each day; morning works best if it gives you energy.",
      "Don't stop suddenly — taper under your care team's direction.",
      "Give side effects a few weeks; most fade.",
    ],
    when_to_contact_provider: [
      "New or worsening thoughts of self-harm — call 988 or 911.",
      "High fever, muscle stiffness, or fast heart rate (rare serotonin syndrome).",
    ],
  },
  albuterol: {
    title: "Albuterol Inhaler",
    summary:
      "Albuterol is a rescue inhaler that opens your airways quickly during an asthma or COPD flare. It works in minutes but does not replace your daily controller.",
    self_care: [
      "Keep it with you everywhere — pocket, bag, glove box.",
      "Shake well and prime before the first use and after any long break.",
      "Rinse your mouth after using it to avoid dry mouth.",
    ],
    when_to_contact_provider: [
      "Using it more than 2 times a week outside of exercise.",
      "Still short of breath 30 minutes after 2 puffs — go to the ER.",
    ],
  },
};

/**
 * Look up patient-facing education for a diagnosis. Matches the longest
 * ICD-10 prefix when a code is provided. When no code matches, falls
 * back to a description keyword search (e.g. "asthma" → J45). Returns
 * null if nothing matches — the caller should render no education card
 * rather than a generic placeholder.
 */
export function getDiagnosisEducation(
  icd10Code: string | null | undefined,
  description: string | null | undefined,
): EducationContent | null {
  if (icd10Code) {
    const trimmed = icd10Code.trim().toUpperCase();
    // Try exact → shorter prefixes. ICD-10 codes are at most 7 chars, so
    // iterate from the full code down to the 3-char chapter code.
    for (let len = trimmed.length; len >= 3; len--) {
      const prefix = trimmed.slice(0, len);
      if (DIAGNOSIS_CONTENT[prefix]) return DIAGNOSIS_CONTENT[prefix];
    }
  }
  if (description) {
    const lower = description.toLowerCase();
    // Description-keyword fallback for rows without an ICD-10 code. Kept
    // intentionally narrow so random text doesn't map to an unrelated card.
    if (/diabetes.*type\s*1|type\s*1\s*diabetes|dm\s*type\s*1/.test(lower)) return DIAGNOSIS_CONTENT.E10!;
    if (/diabetes|dm\b|type\s*2|t2dm/.test(lower)) return DIAGNOSIS_CONTENT.E11!;
    if (/hypertension|high blood pressure|htn\b/.test(lower)) return DIAGNOSIS_CONTENT.I10!;
    if (/atrial fibrillation|afib|a.?fib/.test(lower)) return DIAGNOSIS_CONTENT.I48!;
    if (/heart failure|chf\b/.test(lower)) return DIAGNOSIS_CONTENT.I50!;
    if (/pulmonary embolism|pe\b/.test(lower)) return DIAGNOSIS_CONTENT.I26!;
    if (/deep vein thrombosis|dvt\b/.test(lower)) return DIAGNOSIS_CONTENT.I80!;
    if (/asthma/.test(lower)) return DIAGNOSIS_CONTENT.J45!;
    if (/copd|chronic obstructive/.test(lower)) return DIAGNOSIS_CONTENT.J44!;
    if (/depression|major depressive/.test(lower)) return DIAGNOSIS_CONTENT.F32!;
    if (/anxiety/.test(lower)) return DIAGNOSIS_CONTENT.F41!;
    if (/chronic kidney|ckd/.test(lower)) return DIAGNOSIS_CONTENT.N18!;
  }
  return null;
}

/**
 * Look up patient-facing education for a medication by generic or
 * common brand name. Case-insensitive and alias-aware (Coumadin →
 * warfarin, Lipitor → atorvastatin, Eliquis → apixaban, Zoloft →
 * sertraline, Prilosec → omeprazole, Synthroid → levothyroxine).
 */
export function getMedicationEducation(
  drugName: string | null | undefined,
): EducationContent | null {
  if (!drugName) return null;
  const key = drugName.trim().toLowerCase();

  if (MEDICATION_CONTENT[key]) return MEDICATION_CONTENT[key];

  // Brand-name aliases. Kept local here (rather than reusing the allergen
  // table) because this list is specifically about patient education and
  // may diverge — e.g. we're happy to key Tylenol to a specific acetaminophen
  // article eventually, but the allergen table aliases Tylenol into the
  // acetaminophen cross-reactivity canonical.
  const ALIAS: Record<string, string> = {
    coumadin: "warfarin",
    jantoven: "warfarin",
    eliquis: "apixaban",
    lipitor: "atorvastatin",
    zoloft: "sertraline",
    prilosec: "omeprazole",
    synthroid: "levothyroxine",
    proair: "albuterol",
    ventolin: "albuterol",
    "proair hfa": "albuterol",
  };

  // Multi-word drug names often carry strength info ("lisinopril 10mg");
  // try the first token as a best-effort lookup.
  const firstToken = key.split(/\s+/)[0] ?? key;
  if (MEDICATION_CONTENT[firstToken]) return MEDICATION_CONTENT[firstToken];
  const aliased = ALIAS[firstToken] ?? ALIAS[key];
  if (aliased) return MEDICATION_CONTENT[aliased] ?? null;

  return null;
}

// Exported for tests + downstream reuse.
export const DIAGNOSIS_EDUCATION_TABLE = DIAGNOSIS_CONTENT;
export const MEDICATION_EDUCATION_TABLE = MEDICATION_CONTENT;
