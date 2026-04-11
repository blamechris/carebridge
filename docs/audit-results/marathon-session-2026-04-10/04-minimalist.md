# Minimalist Audit: Marathon Session

**Auditor lens:** YAGNI, complexity reduction, 80/20 cuts, simpler alternatives

---

## Area Ratings (1-5, where 5 = maximally lean)

| Area | Rating | Verdict |
|------|--------|---------|
| services/notifications | 3/5 | DLQ, health check server, preference CRUD — solid but heavier than needed at this stage |
| services/messaging | 4/5 | Clean CRUD, minor bloat in participant verification repetition |
| services/scheduling | 3/5 | Reschedule duplicates double-booking logic; availability calc is bulky |
| ai-oversight rules (allergy, message-screening, med-reconciliation) | 2/5 | Hardcoded regex encyclopedia and cross-reactivity map that will rot |
| ai-oversight escalation-worker | 3/5 | Separate queue+worker for a cron-like job is overkill |
| auth/emergency-access | 4/5 | Appropriately minimal for a compliance requirement |
| patient-portal pages | 3/5 | Massive inline style objects, duplicated layout patterns, symptoms page double-severity |
| clinician-portal schedule | 2/5 | Ships hardcoded placeholder data — dead code in production |
| db-schema (new tables) | 4/5 | Clean, well-indexed, no bloat |

---

## Top 5 Over-Engineered / Cuttable Items

### 1. Allergy cross-reactivity regex map — hand-rolled drug database

**File:** `services/ai-oversight/src/rules/allergy-medication.ts:21-97`

A 13-entry `CROSS_REACTIVITY_MAP` with hardcoded drug names is a maintenance disaster. It will be stale the moment a new drug is prescribed. This is literally reimplementing a subset of what RxNorm/NDF-RT already provides.

**Simpler alternative:** Query RxNorm API (or a local lookup table seeded from their downloadable files) for ingredient-class membership. The entire 80-line regex array becomes one function: `isInSameIngredientClass(allergen, medication)`. If offline lookups are needed, a JSON file from RxNorm is smaller and maintained by the NIH, not by your devs.

---

### 2. Escalation worker uses a dedicated BullMQ queue for what is a cron job

**File:** `services/ai-oversight/src/workers/escalation-worker.ts:112-132`

A repeatable BullMQ job with its own queue (`escalation-checks`), worker, and scheduler — for something that runs a simple DB query every 5 minutes. This introduces a Redis dependency, queue management, and failure handling for code that could be a `setInterval` in the existing ai-oversight process, or a single cron job.

**Simpler alternative:** `setInterval(checkAndEscalate, 5 * 60 * 1000)` inside the already-running ai-oversight worker process. Zero new infrastructure. If you want robustness, a simple pg_cron function or even a Kubernetes CronJob beats maintaining a BullMQ queue for a timer.

---

### 3. Clinician schedule page ships hardcoded placeholder data

**File:** `apps/clinician-portal/app/schedule/page.tsx:48-57`

This page renders static fake appointment slots. It explicitly says "Schedule integration pending" (line 159). This is dead weight that should not have been merged — it adds visual surface area with no backend and will mislead testers.

**Simpler alternative:** Don't merge UI pages until the backing service is wired up. If you must ship the route, show a single "Coming soon" banner (5 lines) instead of 170 lines of mock UI that suggests functionality exists.

---

### 4. Patient symptoms page has redundant severity inputs

**File:** `apps/patient-portal/app/symptoms/page.tsx:152-190`

The page collects severity TWICE: a 1-10 slider (`severityScale`, line 154) AND a mild/moderate/severe toggle (`severityAssessment`, line 170). Both are submitted. The slider alone gives you everything the toggle does (1-3 = mild, 4-6 = moderate, 7-10 = severe). This adds cognitive load for patients and schema complexity.

**Simpler alternative:** Keep only the slider. Derive the text label server-side from the numeric value. Cut 40 lines of UI and one DB column (`severity_self_assessment`).

---

### 5. Notification preferences CRUD built before any delivery channel exists

**File:** `services/notifications/src/router.ts:54-111` and `packages/db-schema/src/schema/notification-preferences.ts`

The preference system supports `in_app`, `email`, `sms` channels and quiet hours — but the dispatch worker (`dispatch-worker.ts`) only creates DB rows. There is no email sender, no SMS gateway, no push notification. The preference table and CRUD endpoints are dead infrastructure serving a feature that does not exist yet.

**Simpler alternative:** Delete the entire `notificationPreferences` table, the `getPreferences`/`updatePreference` endpoints, and the quiet hours logic. When you actually build email/SMS delivery (likely months away), add preferences then. YAGNI textbook case.

---

## Honorable Mentions

- **Messaging router repeats participant-access-check 3 times** (`router.ts:69-79`, `145-160`, `183-194`). Extract to a shared `assertParticipant(db, conversationId, userId)` helper. ~30 lines saved.
- **Scheduling `reschedule` (lines 125-184) duplicates overlap detection** from `create` (lines 50-96). Extract `checkOverlap(tx, providerId, start, end)`.
- **Patient portal pages all duplicate the "find my patient record" pattern** (`patientsQuery.data?.find((p) => p.name === user?.name) ?? patientsQuery.data?.[0]`). This appears in 6 files — should be a single `useMyPatientRecord()` hook.
- **`dispatch-worker.ts` dynamically imports `careTeamMembers` (line 47)** to "avoid circular deps" — this is a code smell suggesting the schema barrel export needs fixing, not a dynamic import in a hot path.
- **Module-level mutable `ruleSequence` counter** in `allergy-medication.ts:116` — non-deterministic across worker restarts, leaks state between test runs.

---

## Overall Rating: 3.0 / 5

**Verdict:** This marathon session shipped real features at speed, but it front-loaded infrastructure (notification preferences, escalation queues, cross-reactivity databases) for capabilities that don't exist yet while simultaneously merging placeholder UIs with fake data. The 80/20 rule was violated in the AI rules layer — regex drug databases and BullMQ cron wrappers add maintenance burden without proportional safety gains over simpler alternatives. The patient portal pages are functional but carry duplicated patterns and redundant inputs that a single afternoon of refactoring could halve. Net: about 20% of the new code could be deleted today with zero feature regression.
