# Patient and family first: working direction

## Confirmed direction

People bring information they can access. The intended system helps them
understand it, notice concerning patterns, and prepare questions for their care
team. Patients and families are the starting point for this direction; CareBridge
may be the underlying system.

This records intent, not a claim that the intended patient/family experience is
implemented or ready for use. No first
clinical use case or rule has been selected. The phrase "concerning patterns"
describes the ambition; what the system could responsibly surface, to whom, and
with what review remains to be defined and evaluated. The examples below explore
information handling and coordination only, without defining clinical alerts.

The personal motivation in [MISSION.md](../../MISSION.md) explains why this work
matters to its founder. Clinical efficacy and outcomes require separate evidence.

## Current research implementation and limits

The [README](../../README.md) describes the existing research platform: a
clinical rules engine and AI oversight layer, synthetic scenarios, and flags for
qualified clinician review. The existing engine is clinician-oriented research;
future patient-facing use of any output is undecided and gated. This direction
does not change the runtime engine or make research flags ready for patients or
families.

The README's warning remains in force: this is pre-launch research software,
not for clinical use; repository patients, scenarios, and examples are synthetic;
real patient data, PHI, and clinical records must never be added; AI flags require
independent clinician review before clinical action; and patient-facing deployment
remains gated by [LAUNCH-CHECKLIST.md](../../LAUNCH-CHECKLIST.md).

The clinician-focused architecture and rule ordering in
[MISSION.md](../../MISSION.md), together with the
[clinician-bridge MVP scope](../clinician-bridge-mvp.md), provide historical
research and design context. Those proposals do not establish implemented
patient-facing capabilities, end-to-end ingestion or sharing, or authority to
collect or share real information. This direction authorizes no real ingestion
or sharing.

## Choices still open

- The first patient/family problem to explore, its boundaries, and observable
  acceptance criteria. No first clinical use case or rule has been selected.
- How people would bring information, what sources could be supported, how
  source references and missing context would appear, and what review would be
  required before any patient-facing interpretation.
- Whether and how information could be shared, including consent, access,
  privacy, retention, and authorization requirements. No real ingestion or
  sharing authority is established here.
- How CareBridge's existing research components could support the intended
  experience, and what new work and validation would be necessary.
- Whether any Epic integration would be useful. None is selected, and replacing
  MyChart is not a selected product goal.
- The legal, regulatory, and device classification of any future patient-facing
  product, based on its eventual behavior and claims. Existing research
  positioning does not settle those questions.

## Three fictional, unranked examples for discussion

Every source snippet below is wholly fabricated. Bracketed document and visit
labels are placeholders, not real records or identifiers. These examples are
unranked and do not select a first use case, promise an implemented feature, or
provide clinical interpretation or advice.

### An unexplained document label

**What the source says**

- `[DOCUMENT A]`, heading: "Tracking category: PENDING-DELTA."
- No definition of that invented label appears in the supplied snippet.

**Unknowns**

The label's meaning, who assigned it, and whether another page explains it are
unknown. The example supplies no basis for interpreting it.

**Possible question to the care team**

"What does this label mean in this document, and where can I find its
explanation?"

**Discussion prompt**

Would showing the exact label beside its source and an explicit unknown help a
person prepare that question? What additional context would they need?

### Two different scheduling instructions

**What the sources say**

- `[FOLLOW-UP NOTE A]`: "The scheduling team will contact you to arrange the next
  appointment."
- `[FOLLOW-UP NOTE B]`: "Please contact the scheduling team to arrange the next
  appointment."

**Unknowns**

The snippets differ on who initiates scheduling. Their order, whether either
supersedes the other, and whether an appointment has already been arranged are
unknown. Neither instruction is chosen as correct here.

**Possible question to the care team**

"These notes give different instructions about who contacts whom. Which
scheduling instruction applies now?"

**Discussion prompt**

Would quoting both instructions with separate source references make the
administrative discrepancy easier to discuss without resolving it automatically?

### A question repeated across a visit timeline

**What the sources say**

| Fictional source | Supplied snippet |
|---|---|
| `[VISIT A NOTE]` | "Question raised: which office handles the appointment paperwork?" |
| `[VISIT B NOTE]` | "Question repeated: which office handles the appointment paperwork?" |
| `[VISIT C NOTE]` | "Asked again which office handles the appointment paperwork." |

**Unknowns**

No answer appears in these supplied snippets. An answer may exist elsewhere;
these excerpts do not establish whether anyone responded outside them or which
office owns the task.

**Possible question to the care team**

"This question appears in each of these notes. Which office handles the
paperwork, and where can I find the answer recorded?"

**Discussion prompt**

Would a source-linked timeline help someone revisit a repeated unanswered
coordination question while making the limits of the supplied excerpts clear?
