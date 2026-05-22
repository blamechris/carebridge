# Patient-education readability — design and multilingual plan

CareBridge surfaces clinician-authored patient-education cards (diagnoses,
medications) in the patient portal. The reading level of those cards is
guarded by a lock test: every PR that touches `patient-education.ts`
must keep the cards within reading-level ceilings.

This doc covers two things:

1. The current English-only guard (PR #962, extended in PR for #975).
2. How the guard extends once translated cards land.

## Current guard — English

The lock test lives at
`packages/medical-logic/src/__tests__/patient-education-reading-level.test.ts`.
Every `summary`, joined `self_care`, and joined `when_to_contact_provider`
block from `DIAGNOSIS_EDUCATION_TABLE` and `MEDICATION_EDUCATION_TABLE`
is graded against **three independent metrics**:

| Metric          | What it measures                                          | Ceiling | Why we use it                                                                 |
|-----------------|-----------------------------------------------------------|---------|-------------------------------------------------------------------------------|
| Flesch-Kincaid  | Sentence length × syllable density                        | 11.0    | Standard patient-education benchmark (HHS Office of Minority Health 6–8th).   |
| SMOG            | Polysyllable count, normalized to 30 sentences            | 13.0    | Stable on short bullet lists where FK gets noisy (words/sentences collapses). |
| Gunning-Fog     | Sentence length + hard-word density (3+ syllables)        | 13.0    | Combines both signals; tends to read 1–2 grades above FK on the same text.   |

A card must clear **all three** ceilings to pass. FK alone can be gamed
by short fragments; SMOG alone misses long-but-simple prose; Gunning-Fog
alone is sensitive to sentence punctuation. The intersection catches
each failure mode.

All three formulas are inlined as small pure functions in the test
file — no runtime dep. Syllables use a vowel-group heuristic that is
"close enough for a guard" (we're catching four-syllable jargon, not
doing comma-level linguistic precision).

### Targets vs ceilings

Ceilings are intentionally above target. HHS targets 6th–8th grade for
consumer-health material; our ceilings are 11.0 (FK) / 13.0 (SMOG) /
13.0 (Fog). The gap exists because legitimate medical terms
(`hypertension`, `immunosuppressant`, `anticoagulation`) push the
metrics up by 2–3 grades regardless of how plain the surrounding
prose is. A ceiling at 8.0 would flake the suite on every clinically
correct card.

If the guard catches a PR, it means the *new* content drifted
significantly above already-loose ceilings — worth re-wording, not
worth fighting the metric.

## Multilingual plan — coming with Spanish first

Flesch-Kincaid, SMOG, and Gunning-Fog are all **English-specific**.
Their formulas are calibrated to English syllable patterns and the
distribution of polysyllables in English text. Applying them to a
Spanish card produces meaningless numbers — Spanish words average more
syllables than English ones, so a perfectly clear Spanish summary
would score "12th grade" by FK and fail the guard.

When translated cards land, the guard needs to know the locale of each
block and route to a language-appropriate metric.

### Per-language metric map

| Language | Metric                                  | Notes                                                           |
|----------|-----------------------------------------|-----------------------------------------------------------------|
| English  | Flesch-Kincaid + SMOG + Gunning-Fog     | Current intersection. Keep as-is.                                |
| Spanish  | Fernández-Huerta + Szigriszt-Pazos       | Fernández-Huerta is the FK analog; Szigriszt is the modernized form. Score ranges differ from FK — Spanish reading-ease "very easy" is ~80–90, English FK grade level reads inverted. |
| German   | LIX + Wiener Sachtextformel             | LIX is sentence-length + long-word density; Wiener is the German-specific grade-level analog. |
| French   | Kandel-Moles                            | French FK analog. Calibrated against French primary-school content. |

Per-language syllable counters need to live next to the metric
functions. The current English `countSyllables` won't carry over —
Spanish has rules for diphthongs and tildes; German has umlauts and
compound-word boundaries.

### Where the code lives

Extract the shared scaffolding (`tokenizeWords`, `countSentences`,
metric dispatch by locale) into a new module:

```
packages/medical-logic/src/readability/
  index.ts              # public surface
  english.ts            # FK, SMOG, Fog + English syllables
  spanish.ts            # Fernández-Huerta, Szigriszt + Spanish syllables (when needed)
  german.ts             # LIX, Wiener (when needed)
  french.ts             # Kandel-Moles (when needed)
  __tests__/readability.test.ts
```

The lock-test imports from `readability` and dispatches per card based
on the locale tag on the card. Test file becomes thin — it iterates
cards, asks the readability module for a verdict, and asserts pass.

### Lock-test policy when locale ≠ English

Two options:

1. **Per-locale lock test, identical structure.** Each language gets
   its own metric+ceiling tuned the same way English's is — generous
   enough to clear legitimate medical terms in that language. This is
   the right end-state; it requires native-speaker calibration for
   each language we add.

2. **Language-agnostic fallback for languages we haven't calibrated.**
   Sentence-length cap (no sentence > 25 words) + typographic checks
   (no walls of all-caps, no abbreviation soup). Catches obvious
   regressions without claiming a grade-level number we can't defend.

Plan: ship option 1 for any language we ship cards in; keep option 2
as the safety net for any locale where the metric module hasn't been
written yet, so a card in a new language doesn't bypass the guard
entirely.

## Acceptance for the first non-English translation

Before the first translated card merges:

- [ ] Decide which locale(s) to support first (likely Spanish per
      patient population).
- [ ] Implement the per-language metric(s) and ceiling under
      `packages/medical-logic/src/readability/<lang>.ts`.
- [ ] Calibrate the ceiling on a small corpus of native-speaker
      patient-education samples (e.g. CDC Spanish materials, NIH
      MedlinePlus Spanish), aiming for the same "loose-enough that
      clinical terms pass" headroom the English guard has.
- [ ] Add the locale tag to the card data and route the lock test
      through `readability` module.
- [ ] Update this doc with the chosen ceiling and a one-line summary
      of the calibration corpus.

## References

- PR [#962](https://github.com/blamechris/carebridge/pull/962) — original Flesch-Kincaid lock test
- Issue [#975](https://github.com/blamechris/carebridge/issues/975) — multi-metric extension + this plan
- HHS Office of Minority Health — Plain Language guidelines (6th–8th grade target)
- McLaughlin (1969) — SMOG Readability Formula
- Gunning (1952) — Technique of Clear Writing (Fog Index)
- Fernández-Huerta (1959) — Medidas sencillas de lecturabilidad (Spanish)
- Bamberger & Vanecek (1984) — Wiener Sachtextformel (German)
