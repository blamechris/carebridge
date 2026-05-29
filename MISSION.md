# CareBridge Mission

> The system should force the surfacing of cross-specialty deterioration patterns that tired or siloed clinicians miss, especially during inpatient stays and discharge decisions.

## Why this exists

> _Personal foreword from Chris Pishaki, project founder. This section is
> first-person and intentionally not technical. The rest of the document is._

My mom died from a care coordination failure.

It wasn't one big mistake. It was a slow accumulation: multiple hospital admissions, deterioration across them, repeated warning signs in the chart that were underweighted, fragmented across specialties, or lost in messy and copy-pasted documentation. Discharges happened before they should have. Symptoms were noted but not connected. Labs trended in directions that mattered, but nobody owned the trajectory. Each specialty saw their slice. None of them saw the patient getting worse.

When I read her chart after she died, the pattern was obvious. It was obvious in retrospect because all of the pieces were there — in writing — across notes nobody had stitched together. Tired clinicians on rotating shifts in siloed services missed what a careful reader with all the context would have caught immediately.

I built CareBridge because computers don't get tired. They don't skip iterations because they're behind on rounds. They don't copy-paste yesterday's note and forget to check whether yesterday's note is still true. A system that systematically surfaces the cross-specialty deterioration pattern at the moments that matter — readmission, shift change, discharge decision — is a thing that should exist and didn't. Now it does.

This project is not a replacement for clinicians. It's a checklist made by a grieving family member, written so that the next family doesn't have to do the post-mortem I did.

— Chris Pishaki, 2026

## The failure class

CareBridge addresses **cross-specialty deterioration patterns** — a class of clinical failure that single-specialist EHR notes structurally cannot catch because:

1. **No single clinician owns the trajectory.** Hospitalists hand off at shift change. Specialists see slices. ICU teams rotate. The patient's worsening trend lives in the difference between notes nobody compares side-by-side.
2. **Soft signals don't trip hard thresholds.** A heart rate of 95, a respiratory rate of 22, a white count of 12, and a temperature of 100.4 are each "soft." Together they meet SIRS criteria. The chart records each value; the workup that should have followed often doesn't.
3. **Copy-forwarded notes drift.** A note carried forward from the prior shift can describe a patient who has materially changed since. The reader trusts the documented state; the documented state lags reality.
4. **Discharge decisions get made under pressure.** Length-of-stay metrics, bed pressure, and shift-end fatigue push patients out the door with unresolved labs, open consult requests, and symptoms that were noted but not investigated.
5. **Hospitals only see one admission at a time.** A patient who has been readmitted three times in 90 days is treated as a new admission at the third hospital. The trajectory across admissions — the most important signal of deteriorating disease — is invisible to any single institution's EHR.

These are the failure modes CareBridge is designed to catch. None are diagnoses. All are pattern-recognition tasks that benefit from a system that never gets tired.

## What CareBridge does

Mechanically, CareBridge is a **deterministic clinical pattern engine** with three layers:

1. **A structured chart-taking system** for clinicians. Symptom capture with negation-awareness, body-system grouped ROS, NS↔ROS auto-mirror, age-stratified vital validators. The goal is to make structured documentation faster than free-text narrative so that downstream pattern detection has clean inputs to work against.
2. **A deterministic rules engine** (`services/ai-oversight/src/rules/`) that runs against the structured chart. Rules encode known dangerous patterns — drug interactions, cross-specialty risk combinations, and (starting with this milestone) deterioration trajectories. Rules are pure functions over a `PatientContext` snapshot, fully auditable, and never depend on LLM behavior.
3. **An optional LLM second-pass review** via Claude API. The LLM reviews cases the deterministic rules already flagged, looking for nuance the rules couldn't encode. It never originates clinical decisions — it elaborates on what the deterministic layer surfaced.

The output is a **flag**: a structured record with severity, category, summary, rationale, suggested action, and the specialties that should see it. Flags surface in clinician inboxes and (via the bridge, see below) in printed bedside summaries that family caregivers can hand to any clinician.

## What CareBridge does NOT do

CareBridge is positioned as **non-device clinical decision support** under the 21st Century Cures Act exemption (see `docs/cds-exemption.md`). To stay on the safe side of that line, CareBridge:

- **Does not prescribe, dose, or order anything.** No orders are generated. No "give patient X" recommendations.
- **Does not diagnose.** Rules surface concerning patterns and suggest workups; they never assert what the patient has.
- **Discloses its underlying data and logic to the user.** Every flag carries citations and the rationale that produced it. A clinician can read the input and the logic and decide independently.
- **Does not auto-act.** Every flag requires a clinician to read and decide. Nothing happens in the chart without human action.
- **Does not replace clinician judgment.** Flags are checklists, not verdicts.

## Architecture: MedLens + CareBridge + the bridge

CareBridge does not exist alone. It is one half of a **two-app patient-safety stack**:

- **MedLens** (`/Users/blamechris/Projects/medlens`) — a React Native / Expo mobile app for **patient and family-caregiver capture**. Photographs whiteboards, IV bags, lab printouts; OCRs them; stores everything locally on the device. Explicitly **does not interpret** data into clinical advice (see [`medlens/NON-GOALS.md`](../medlens/NON-GOALS.md)). The SaMD firewall lives at this boundary: MedLens captures, CareBridge interprets.
- **CareBridge** (this repo) — the clinician-facing chart system + AI oversight engine. Lives on the web. Talks to MedLens through a patient-controlled scoped-token bridge so family caregivers can share their longitudinal capture with whatever clinician they hand a printed summary to.
- **The bridge** (`services/fhir-gateway/src/medlens-bridge.ts` — currently stubbed; to be built out) — a no-login, no-account-required web view at carebridge.app where a clinician redeems a one-time token (or scans a QR code) and sees the patient's structured history + the AI oversight engine's flags. Designed for the on-call hospitalist who doesn't want to install anything.

The longitudinal-across-admissions property — the thing hospitals structurally cannot see — comes from MedLens being on the family caregiver's phone, not the hospital's server. The family follows the patient across admissions; MedLens captures across admissions; CareBridge runs deterioration-trajectory rules across that longitudinal data; the clinician gets it in one summary.

## First rule: DETERIORATION-TRAJECTORY-001

The first major rule in the deterioration-trajectory family is an **umbrella** that runs six sub-checks at three triggers (new admission with priors, shift change, discharge decision):

| Sub-rule | What it catches | Priority |
|---|---|:---:|
| READMISSION-TRAJECTORY | Patient readmitted within 30/60/90d with worsening labs/vitals/symptoms across admissions | **1st** |
| DISCHARGE-READINESS | Discharge language appearing while labs are trending wrong, consults are open, or symptoms are unresolved | **2nd** |
| CROSS-SPECIALTY-SYMPTOM-ORPHAN | Symptom documented across multiple specialty notes with no owning workup | **3rd** |
| WARNING-SIGN-AGGREGATOR | Individually-soft signals (HR/RR/WBC/temp) that meet a composite criterion (SIRS, qSOFA, MEWS) | future |
| COPY-FORWARD-DRIFT | Note text > 80% similarity to prior shift's note where at least one clinical signal has changed since | future |
| CONSULT-LOOP-OPEN | Consult requested ≥24h ago without a closing note linked back | future |

The scaffolding for all six lives in `packages/medical-logic/src/deterioration-patterns.ts`. The first three ship as the founding milestone. The other three follow as the data model fills out.

## Status & how to contribute

This is a pre-launch solo project. Building publicly. Mission-first.

- **Architecture**: see [`docs/`](docs/) and [`README.md`](README.md)
- **Open issues**: GitHub issues. Pinned issue points at the first-time-contributor scope.
- **Clinical accuracy**: see [`docs/ai-prompt-editing.md`](docs/ai-prompt-editing.md) for the merge-gate vs launch-gate split and [`LAUNCH-CHECKLIST.md`](LAUNCH-CHECKLIST.md) for pending clinical attestations.
- **What I'm not doing**: see this document's "What CareBridge does NOT do" section. If you're tempted to add a feature that crosses that line, propose it on an issue first.

If you're a clinician (PharmD / physician / informaticist) and want to help review the rules engine before launch, the path is in `LAUNCH-CHECKLIST.md`. If you're a software engineer who wants to contribute, the open issues are labeled by complexity.

If you're a family caregiver who has been through what I went through, I am sorry. Email me at the address in my GitHub profile. I want to hear how this could have helped, and where it would not have.
