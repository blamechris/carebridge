# Builder Audit: Marathon Session (2026-04-10)

## Scope

19 PRs merged in rapid succession. This audit assesses each feature for end-to-end implementability, focusing on whether things are actually wired up and usable vs. partially implemented.

---

## Area Ratings (1-5)

### 1. tRPC Router Registration & Reachability: 4/5

All major service routers are registered in `services/api-gateway/src/router.ts`:
- `messaging` -> registered (line 28)
- `scheduling` -> registered (line 29)
- `notifications` -> registered (line 26)
- `emergencyAccess` -> registered (line 21)
- `aiOversight` -> registered (line 25)

**Gap:** The `patients.observations` sub-router does NOT exist in the api-gateway's `patientRecordsRbacRouter` (`services/api-gateway/src/routers/patient-records.ts`). The observations CRUD lives in `services/patient-records/src/router.ts` (line 79) but is never imported or exposed through the gateway. The patient symptom journal page (`apps/patient-portal/app/symptoms/page.tsx`) calls `trpc.patients.observations.getByPatient` and `trpc.patients.observations.create` which will throw runtime errors.

### 2. Frontend Pages & tRPC Wiring: 3/5

**Working:**
- Patient messaging (`apps/patient-portal/app/messages/page.tsx`) - fully wired to `trpc.messaging.*`
- Clinician messaging (`apps/clinician-portal/app/messages/page.tsx`) - fully wired
- Patient labs (`apps/patient-portal/app/labs/page.tsx`) - fully wired
- Patient clinical notes (`apps/patient-portal/app/notes/page.tsx`) - fully wired
- Patient health summary (`apps/patient-portal/app/health-summary/page.tsx`) - fully wired
- Medication refill request (`apps/patient-portal/app/refill/page.tsx`) - sends messages correctly

**Broken:**
- Patient symptom journal (`apps/patient-portal/app/symptoms/page.tsx`) - calls non-existent `trpc.patients.observations.*`
- Clinician schedule (`apps/clinician-portal/app/schedule/page.tsx`) - **hardcoded placeholder data**, explicitly says "Schedule integration pending" (line 159). Does NOT call the scheduling tRPC router despite it being available.
- Patient dashboard (`apps/patient-portal/app/page.tsx` line 29) - calls `trpc.patients.list.useQuery()` but RBAC router throws FORBIDDEN for patient-role users (see `services/api-gateway/src/routers/patient-records.ts` line 123-130). The entire patient portal dashboard is broken for actual patient accounts.

### 3. Migrations & Schema Consistency: 5/5

All 22 migrations present and consistent:
- `0017_messaging_tables.sql` - conversations, participants, messages
- `0018_patient_observations.sql` - patient_observations table
- `0019_scheduling_tables.sql` - appointments, provider_schedules, schedule_blocks
- `0020_emergency_access.sql` - emergency_access table
- `0021_notification_preferences.sql` - notification_preferences

Schema exports in `packages/db-schema/src/schema/` align with migrations. No missing tables.

### 4. BullMQ Workers & Background Processing: 4/5

**Running correctly:**
- AI oversight review worker: started in `services/ai-oversight/src/server.ts` (line 15)
- Escalation worker: started in same file (line 17), repeatable job pattern
- Notification dispatch worker: started in `services/notifications/src/server.ts` (line 13)

**Gap:** The notification dispatch worker creates DB records but does NOT publish to Redis Pub/Sub (`notifications:{userId}` channel). The SSE endpoint at `services/api-gateway/src/routes/notifications-sse.ts` subscribes to that channel, but nothing ever publishes to it. The `publishNotificationToUser` helper exists (line 85) but is never called from the dispatch worker.

### 5. Seed Data: 3/5

The seed file (`tooling/seed/index.ts`) covers:
- Users (4 dev accounts)
- Patients (2: DVT scenario + diabetes/hypertension)
- Diagnoses, allergies, medications, vitals, labs, care team

**Missing seed data for new features:**
- No scheduling data (provider_schedules, appointments) - schedule page has nothing to show
- No messaging conversations - messaging UI starts empty (acceptable but limits demo)
- No notification_preferences - preferences page starts blank
- No emergency_access records - no way to test the flow without manual API calls
- No patient_observations - symptom journal empty

### 6. AI Oversight Rule Integration: 4/5

Review service (`services/ai-oversight/src/services/review-service.ts`) integrates:
- Critical values (line 80)
- Cross-specialty patterns (line 89)
- Drug interactions (line 97)
- Allergy-medication cross-check (line 105)
- Message screening (line 112-118)

**Gap:** `medication-reconciliation.ts` defines `checkMedicationReconciliation()` but it is NEVER imported or called from the review service. It's dead code.

### 7. Security Features (Emergency Access): 2/5

The break-the-glass feature (`services/auth/src/emergency-access.ts`) creates records and audit entries. However, the RBAC middleware at `services/api-gateway/src/middleware/rbac.ts` (function `assertCareTeamAccess`, line 93-118) ONLY checks `careTeamAssignments` - it never queries the `emergency_access` table. This means:
- A provider can request emergency access (record gets created)
- But the RBAC check still denies access (never reads the emergency grant)
- Feature is non-functional end-to-end

---

## Top 5 "Not Actually Done Yet" Findings

### 1. Patient Portal Dashboard is Broken for Patient Users

**Severity:** Critical (blocks all patient portal usage)

The patient portal dashboard (`apps/patient-portal/app/page.tsx:29`) calls `trpc.patients.list.useQuery()`. The RBAC router (`services/api-gateway/src/routers/patient-records.ts:123-130`) explicitly throws `FORBIDDEN` for patient-role users. Every subsequent page (labs, notes, health-summary, messages, refill) also calls `patients.list` to find "my record" via name matching (pattern: `patientsQuery.data?.find(p => p.name === user?.name)`). This pattern is broken because the query itself fails.

**Fix needed:** Add a `patients.me` procedure that returns the patient record linked to the authenticated user, or allow patients to call `.list` filtered to only their own record.

### 2. Patient Symptom Journal Router Missing from Gateway

**Severity:** High (page loads but all data operations fail)

`apps/patient-portal/app/symptoms/page.tsx` calls:
- `trpc.patients.observations.getByPatient` (line 37)
- `trpc.patients.observations.create` (line 42)

But `services/api-gateway/src/routers/patient-records.ts` has no `observations` sub-router. The implementation exists in `services/patient-records/src/router.ts:79` but isn't exposed.

**Fix needed:** Add `observations` sub-router to `patientRecordsRbacRouter` with proper RBAC guards, or re-export it from the patient-records package and merge into the gateway router.

### 3. Break-the-Glass Emergency Access is Non-Functional

**Severity:** High (security feature that doesn't work)

`services/auth/src/emergency-access.ts` creates `emergency_access` records. But `services/api-gateway/src/middleware/rbac.ts:assertCareTeamAccess()` only queries `careTeamAssignments`. A valid emergency access grant is completely ignored.

**Fix needed:** In `assertCareTeamAccess`, after the care-team check fails, query `emergency_access` for a non-expired, non-revoked grant for that user+patient pair.

### 4. Real-Time Notifications (SSE) Has No Last-Mile Delivery

**Severity:** Medium (SSE endpoint works but nothing publishes to it)

- `services/api-gateway/src/routes/notifications-sse.ts` subscribes to Redis `notifications:{userId}` channel
- `services/notifications/src/workers/dispatch-worker.ts` inserts notification records into DB (line 149) but never calls `publishNotificationToUser` to push them via Redis Pub/Sub
- No frontend code uses `EventSource` to connect to `/notifications/stream`

**Fix needed:**
1. Import and call `publishNotificationToUser` after DB insert in dispatch worker
2. Add `EventSource` hook in clinician-portal to consume the stream

### 5. Clinician Schedule Page is a Static Shell

**Severity:** Medium (page exists but shows hardcoded mock data)

`apps/clinician-portal/app/schedule/page.tsx` has hardcoded slots (lines 48-57) with a comment: "Placeholder slots - will be replaced with tRPC query once scheduling service is merged". The scheduling service IS merged and available at `trpc.scheduling.appointments.listByProvider` and `trpc.scheduling.schedule.availability`. The page simply wasn't updated.

**Fix needed:** Replace static `slots` array with `trpc.scheduling.appointments.listByProvider.useQuery()` and/or `trpc.scheduling.schedule.availability.useQuery()`.

---

## What's Needed for Production-Ready

### Critical (must-fix before any demo)
1. Add `patients.me` or `patients.getMyRecord` tRPC procedure for patient-role users
2. Wire `observations` sub-router into api-gateway's patient-records router
3. Connect emergency access grants to RBAC middleware

### High Priority
4. Publish notifications to Redis Pub/Sub from dispatch worker
5. Wire clinician schedule page to scheduling tRPC
6. Add clinician-side refill approve/deny UI (currently patients can request but clinicians can only reply via general messaging)
7. Wire `checkMedicationReconciliation` into the review service pipeline

### Medium Priority
8. Add `EventSource` consumer in clinician-portal for real-time notifications
9. Add seed data for scheduling (provider templates, sample appointments)
10. Add seed data for patient_observations (sample entries)
11. Add notification preferences seed data

### Low Priority (polish)
12. Clinician messages page has no way to distinguish refill_request messages from regular text
13. No UI for emergency access request (only API endpoint)
14. No admin view for reviewing emergency access audit trail
15. Patient portal uses name-matching to find patient record (fragile) - should use user_id linkage

---

## Overall Rating: 3.5 / 5

**Verdict:** The marathon session produced impressive architectural breadth - 19 features spanning messaging, scheduling, AI rules, real-time notifications, emergency access, and patient-facing views. The backend implementations are generally solid with proper transaction handling, audit logging, and queue infrastructure. However, roughly 40% of features have broken last-mile wiring: the patient portal dashboard crashes for patient users (the primary persona), the symptom journal fails silently, emergency access is security theater, and the real-time notification pipeline has no actual delivery. The code quality is high where it exists, but several features are "done at the service layer, not done at the integration layer." Two to three focused days of integration work would bring this to a genuinely shippable state.
