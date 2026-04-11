# Skeptic Audit: Marathon Session (2026-04-10)

## Area Ratings

### 1. Notification System (services/notifications/, escalation worker) — 3/5

**Strengths:**
- Dispatch worker has proper DLQ handling, exponential backoff, concurrency control.
- Escalation worker correctly identifies stale flags by severity threshold.
- Health-check server with Redis ping for liveness probes.
- Notification titles/body encrypted at rest via `encryptedText` custom type.

**Weaknesses:**
- **SSE is disconnected from the dispatch pipeline.** The `dispatch-worker.ts` creates notification DB records but never calls `publishNotificationToUser()` (defined in `services/api-gateway/src/routes/notifications-sse.ts:85`). The SSE endpoint subscribes to Redis pub/sub channel `notifications:{userId}` but nothing ever publishes there. Real-time delivery is dead on arrival.
- **Notification preferences are stored but never consulted.** The `updatePreference` and `getPreferences` routes exist in `services/notifications/src/router.ts:54-111`, but the dispatch worker (`dispatch-worker.ts:116-157`) inserts notifications without checking whether the user has that notification type/channel disabled or is in quiet hours. Preferences are write-only.
- The escalation worker re-notifies with the same specialty list as the original (`escalation-worker.ts:83`). The "broader audience" claim in the JSDoc is false -- no additional specialties or supervisors are added.

### 2. Clinical Safety Rules (allergy-medication.ts, message-screening.ts, medication-reconciliation.ts) — 3/5

**Strengths:**
- Allergy cross-reactivity map is clinically reasonable (penicillin-cephalosporin cross, sulfonamides, etc.).
- Message screening has sensible patterns for stroke, suicidal ideation, anaphylaxis.
- Medication reconciliation logic for detecting unintentional discontinuation is sound.

**Weaknesses:**
- **Message screening will never fire.** The messaging router (`services/messaging/src/router.ts:222-236`) emits events with `message_id` and `sender_role` but explicitly omits the message body (comment on line 232: "Don't include body in event"). The screening rule (`message-screening.ts:180`) reads `event.data.message_text` which is never populated. The comment says "AI oversight reads it from DB" but the deterministic keyword screening runs first without DB access. The screening function receives an empty string and returns no flags.
- **Global mutable `ruleSequence` in allergy-medication.ts (line 116)** is a module-level `let` that monotonically increases across worker invocations within a process. In a long-running worker, rule IDs like `ALLERGY-MED-047` are non-deterministic and depend on process history. If the worker restarts, the sequence resets to 0, producing duplicate rule IDs for unrelated flags.
- **Medication reconciliation compares current active meds against only meds linked to the previous encounter** (`medication-reconciliation.ts:71-77`). If a medication was prescribed outside an encounter context (e.g., refill), it won't appear in `previousMeds` and won't trigger a reconciliation flag -- silent false negative.

### 3. Messaging Service (services/messaging/) — 3/5

**Strengths:**
- Access control: verifies user is a participant before reading/sending messages.
- Messages encrypted at rest via `encryptedText` Drizzle custom type (schema at `packages/db-schema/src/schema/messaging.ts:41`).
- Clinical event emission on patient messages for AI oversight integration.

**Weaknesses:**
- **`createConversation` hardcodes participant role assignment incorrectly.** Line 128: `role: userId === input.createdBy ? "patient" : "provider"`. If a provider creates a conversation on behalf of a patient, the provider gets labeled "patient" and the actual patient gets "provider". The assumption that `createdBy` is always the patient is baked in and wrong for clinician-initiated messaging.
- **`markRead` has a read-modify-write race condition.** Lines 250-262: reads `read_by` array, checks membership, pushes, writes back. Two concurrent readers will clobber each other's read status (last-write-wins on the JSON array). No transaction, no optimistic locking.
- **No pagination on `listConversations`.** Returns all conversations for a user with no limit. For a busy provider with years of patient conversations, this will degrade.

### 4. Patient Portal Pages (apps/patient-portal/app/) — 3/5

**Strengths:**
- Symptom journal (`symptoms/page.tsx`) has good structured data collection (type, severity scale, body location, duration).
- Messages UI correctly handles compose, thread expansion, real-time reply.
- Refill workflow creates a proper conversation thread with structured body.

**Weaknesses:**
- **Patient identity resolution is fragile.** Every page uses: `patientsQuery.data?.find(p => p.name === user?.name) ?? patientsQuery.data?.[0]` (e.g., `symptoms/page.tsx:33-34`, `messages/page.tsx:26-27`, `refill/page.tsx:12-13`). Matching by name is unreliable (name collisions, name changes). The fallback to `data?.[0]` means if the name match fails, any random patient record gets used -- a HIPAA violation waiting to happen.
- **Labs page assumes a specific response shape** (`labs/page.tsx:73-76`) with `entry.panel` and `entry.results` nested structure that must be returned by the tRPC endpoint. If the endpoint returns a flat array (common Drizzle pattern), the page silently renders nothing.
- **No error boundaries** on any patient portal page. tRPC mutation failures (network issues, auth expiry) show no user feedback beyond the button state resetting.
- **Refill page `note` field is shared across all medications** but positioned below the list (lines 167-188). User can type a note, click "Request Refill" on medication A (which uses the note), but then the note is cleared on success -- if they intended the note for medication B, it's gone.

### 5. Scheduling Service (services/scheduling/) — 3/5

**Strengths:**
- `appointments.create` uses a database transaction for double-booking prevention (`scheduling/src/router.ts:65-96`).
- Availability calculation properly considers both existing appointments and schedule blocks.

**Weaknesses:**
- **`reschedule` is NOT transactional.** (`scheduling/src/router.ts:132-184`) The cancel and re-create are separate operations with a conflict check in between -- without a transaction. Race condition: two concurrent reschedules can both cancel the original, both pass the conflict check, and both insert new overlapping appointments.
- **`is_active` is stored as text "true", not boolean.** (`packages/db-schema/src/schema/scheduling.ts:43`) The `availability` query compares with `eq(providerSchedules.is_active, "true")` which works, but it's a type mismatch waiting to bite. Any code that assigns a boolean `true` instead of the string `"true"` will silently fail the equality check.
- **`setProviderSchedule` always inserts, never upserts.** (`scheduling/src/router.ts:285-303`) Calling it twice for the same provider + day creates duplicate schedule templates. The `availability` query uses `limit(1)` implicitly by destructuring `[template]`, so it picks one arbitrarily.

### 6. Auth/Security (emergency-access.ts, PHI encryption) — 4/5

**Strengths:**
- Encryption is AES-256-GCM with random IV, auth tag validation, proper key length enforcement.
- Key rotation support with fallback decryption (`decryptWithFallback`).
- Emergency access is time-limited (4h), audit-logged, revocable.
- HMAC-based indexing for encrypted fields is a solid pattern.

**Weaknesses:**
- **Emergency access `request` has no authorization check.** (`services/auth/src/emergency-access.ts:26-65`) Any authenticated user can request access to any patient by passing any `userId`. There's no verification that the requesting user IS the `userId` they're claiming, or that they have a role that permits emergency access (e.g., a patient account shouldn't be able to break-the-glass on another patient).
- **Audit log `ip_address` is always empty string** (line 55). This defeats the purpose of audit logging for forensic analysis. The IP should come from the request context.
- **No rate limiting** on emergency access requests. A compromised account can enumerate patients.

---

## Top 5 Findings (Things That Won't Work)

### 1. SSE Real-Time Notifications Are Dead Code
**File:** `services/notifications/src/workers/dispatch-worker.ts` vs `services/api-gateway/src/routes/notifications-sse.ts`

The SSE endpoint (`notifications-sse.ts:52-61`) subscribes to Redis pub/sub channel `notifications:{userId}`. The dispatch worker (`dispatch-worker.ts:148-149`) only inserts DB records -- it never publishes to Redis. The `publishNotificationToUser` function exists (line 85 of notifications-sse.ts) but is never imported or called anywhere in the dispatch worker. Users will connect to SSE, get the "connected" event, then hear nothing forever.

### 2. Message Screening Cannot Access Message Content
**File:** `services/messaging/src/router.ts:228-234` and `services/ai-oversight/src/rules/message-screening.ts:180`

The messaging service explicitly omits the message body from the clinical event (line 232 comment: "Don't include body in event"). The screening rule reads `event.data.message_text` which is always undefined/empty. The entire urgent-symptom-keyword-detection system (chest pain, stroke symptoms, suicidal ideation) is non-functional. A patient messaging "I want to kill myself" generates zero clinical flags.

### 3. Scheduling Reschedule Has a Race Condition
**File:** `services/scheduling/src/router.ts:132-184`

Unlike `create` (which uses `db.transaction`), `reschedule` performs cancel, conflict-check, and insert as three separate database operations. Under concurrent load, two requests can race past the conflict check and create overlapping appointments. In a healthcare context, this means double-booked procedures.

### 4. Patient Identity Resolution Defaults to Wrong Patient
**File:** `apps/patient-portal/app/symptoms/page.tsx:33-34` (and all other patient portal pages)

Pattern: `patientsQuery.data?.find(p => p.name === user?.name) ?? patientsQuery.data?.[0]`. If the name lookup fails (which it will for any patient whose display name doesn't exactly match the `patients` table name field), the fallback `?.[0]` returns the first patient in the database. Symptoms, messages, and refill requests get attributed to the wrong patient. This is a data integrity and HIPAA violation.

### 5. Notification Preferences Are Never Enforced
**File:** `services/notifications/src/router.ts:54-111` vs `services/notifications/src/workers/dispatch-worker.ts:116-157`

Users can set preferences (disable channels, set quiet hours), but the dispatch worker unconditionally creates notification records for all recipients. There is no code path that reads preferences before deciding whether/how to notify. The preferences UI gives users a false sense of control.

---

## Concrete Recommendations

1. **Wire SSE to dispatch worker:** Import `publishNotificationToUser` in `dispatch-worker.ts` and call it after each notification insert, passing the Redis client from the worker connection.

2. **Fix message screening data flow:** Either include a sanitized message excerpt in the clinical event payload (accepting the PHI-in-queue tradeoff), or have the screening rule fetch the message from DB using `message_id` before keyword matching.

3. **Wrap `reschedule` in a transaction:** Replace the three-step operation with `db.transaction(async (tx) => { ... })`, same pattern already used by `create`.

4. **Replace name-based patient lookup:** Add a `patient_id` field to the user/session context. The patient portal should receive the linked patient ID from auth, not guess it by string-matching names.

5. **Enforce preferences in dispatch worker:** Before inserting notifications, query `notificationPreferences` for each recipient. Skip or defer (quiet hours) based on user settings.

---

## Overall Rating: 3/5

**Verdict:** This is a structurally sound skeleton with correct architectural instincts (encrypted PHI at rest, BullMQ for async processing, tRPC for type safety, transactional double-booking prevention) that was clearly built at speed. The seams show in the integration layer: components were developed in isolation and never connected end-to-end. The SSE pipe has no water flowing through it. The message screening system cannot see the messages. Notification preferences are stored but ignored. The scheduling service learned from the create operation's transactional pattern but forgot to apply it to reschedule. The patient portal's identity resolution would fail the first time two patients share a name. None of these are architectural dead-ends -- they're all fixable in a day -- but as shipped, at least three safety-critical paths (message screening, real-time alerts, scheduling conflicts) are non-functional despite appearing complete in the PR descriptions.
