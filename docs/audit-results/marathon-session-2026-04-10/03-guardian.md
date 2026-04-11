# Guardian Audit: Marathon Session Security & Reliability Review

**Auditor:** Guardian (Security/SRE)
**Date:** 2026-04-10
**Scope:** 19 PRs merged (#339-#357) covering notifications, messaging, clinical safety rules, patient portal, scheduling, break-the-glass access

---

## Area Ratings

### 1. PHI Handling (Encryption at Rest, No PHI in Redis/BullMQ/Logs) — Rating: 3/5

**Strengths:**
- Message bodies encrypted at rest via Drizzle `encryptedText` custom type (`packages/db-schema/src/schema/messaging.ts:41`)
- Notification `title` and `body` encrypted at rest (`packages/db-schema/src/schema/notifications.ts:9-10`)
- BullMQ clinical-events payload explicitly omits message body (`services/messaging/src/router.ts:230-231`, comment: "Don't include body in event")
- PHI redaction pipeline for LLM prompts is thorough (`packages/phi-sanitizer/src/redactor.ts`)
- `summary_safe` field exists for push-notification-safe content

**Weaknesses:**
- The SSE publish function (`services/api-gateway/src/routes/notifications-sse.ts:85-99`) accepts plaintext `title` and publishes it to Redis pub/sub as JSON. When this is eventually wired up, decrypted notification titles (which "may contain PHI" per schema comment) will flow through Redis channels in cleartext.
- The notification dispatch worker (`services/notifications/src/workers/dispatch-worker.ts:136-148`) builds notification records with `title` from `buildNotificationTitle()` and `body` from `event.summary`. These are stored encrypted (good), but the `event.summary` field in the BullMQ notification queue payload (`services/notifications/src/queue.ts:20`) is plaintext in Redis.
- Escalation worker publishes `flag.summary` to the notifications queue (`services/ai-oversight/src/workers/escalation-worker.ts:89`). Clinical flag summaries contain PHI-adjacent information (medication names, conditions). This sits in Redis as plaintext JSON until consumed.
- Worker log messages include `patient_id` UUIDs (`services/notifications/src/workers/dispatch-worker.ts:126-127`). While UUIDs alone are not PHI, combined with timestamps in log aggregation they create a linkage risk.

### 2. Race Conditions — Rating: 3/5

**Strengths:**
- Appointment creation uses `db.transaction()` to wrap check+insert, preventing double-booking TOCTOU (`services/scheduling/src/router.ts:65-96`)
- Flag deduplication uses DB-level existence check before insert (`services/ai-oversight/src/services/flag-service.ts:39-78`)
- Escalation worker runs with `concurrency: 1` (`services/ai-oversight/src/workers/escalation-worker.ts:157`)

**Weaknesses:**
- **CRITICAL: Message read receipts have a read-modify-write race** (`services/messaging/src/router.ts:247-266`). The `markRead` procedure reads `message.read_by`, appends the userId, then writes back. Two concurrent `markRead` calls can lose one user's read receipt. No transaction or optimistic locking.
- **Rescheduling is not transactional** (`services/scheduling/src/router.ts:131-183`). The cancel and conflict-check+insert are separate DB calls without a transaction. A concurrent booking can slip in between the cancel and the new insert, or a failure after cancel but before insert leaves the patient with no appointment.
- **Flag deduplication in `createFlag` is a TOCTOU race** (`services/ai-oversight/src/services/flag-service.ts:39-93`). The SELECT to check for duplicates and the INSERT are not in a transaction. Under high concurrency (multiple events for same patient processed simultaneously by 5-worker concurrency), duplicate flags can be created.
- **`ruleSequence` module-level counter** (`services/ai-oversight/src/rules/allergy-medication.ts:116`) is a shared mutable global. In a single-process Node.js worker this is safe, but the ever-incrementing counter means rule_ids drift across restarts, making deduplication by rule_id unreliable for allergy rules specifically.
- **RBAC care-team cache** (`services/api-gateway/src/middleware/rbac.ts:43-69`) has a 5-second TTL. A revoked care-team assignment is still cacheable for up to 5 seconds. The comment acknowledges this but it represents a window where a removed provider can still access patient data.

### 3. Error Handling (Redis Down, DB Slow) — Rating: 4/5

**Strengths:**
- BullMQ workers have exponential backoff retry (5 attempts on clinical-events, 3 on notifications)
- Dead Letter Queues (DLQ) capture exhausted jobs for both review-worker and dispatch-worker
- DLQ insertion failures are caught and logged without crashing the worker
- Redis connection is configured via shared `getRedisConnection()` (`packages/redis-config/src/redis.ts`)
- Rate limiter on the API gateway prevents cascading load
- Review service records failures in `review_jobs` table with error details

**Weaknesses:**
- `enableOfflineQueue: false` on the rate-limit Redis client (`services/api-gateway/src/server.ts:27`) means if Redis is down, rate limiting fails. This is actually the *right* behavior (fail-open for availability) but should be documented as a security trade-off.
- The SSE endpoint creates a new Redis subscriber per connection (`services/api-gateway/src/routes/notifications-sse.ts:52`). Under connection storms this could exhaust Redis connections. No connection pooling or max-connections guard.
- `clinicalEventsQueue` in messaging (`services/messaging/src/router.ts:26-34`) is initialized at module load time. If Redis is unavailable at import, the Queue constructor may throw, crashing the service on startup rather than degrading gracefully.
- No circuit breaker pattern on the Claude API call in review-service. The rate limiter (10/min) helps but a sustained Claude outage will fill the queue with retrying jobs.

### 4. Auth Boundaries — Rating: 2/5

**Strengths:**
- Patient-records, clinical-data, clinical-notes, and FHIR routers have proper RBAC enforcement via `assertPatientAccess()` / `enforcePatientAccess()` (file: `services/api-gateway/src/middleware/rbac.ts:135-179`)
- Auth middleware validates JWT signatures before DB lookup (`services/api-gateway/src/middleware/auth.ts:100-108`)
- Deactivated users have sessions rejected and audit-logged (`services/api-gateway/src/middleware/auth.ts:151-174`)
- Dev-auth is gated behind both `NODE_ENV !== "production"` and explicit `CAREBRIDGE_DEV_AUTH=true`
- Emergency access has time limits and mandatory justification (`services/auth/src/emergency-access.ts:20`)

**Weaknesses:**
- **CRITICAL: Messaging, scheduling, and notifications routers have NO auth enforcement.** These routers (`services/messaging/src/router.ts`, `services/scheduling/src/router.ts`, `services/notifications/src/router.ts`) use standalone `initTRPC.create()` without context. They accept `userId` as a trusted input parameter. Any authenticated user can pass ANY userId to read another user's conversations, appointments, or notifications. The gateway `authMiddleware` sets `request.user` but these routers never check it — they trust the client-supplied `userId`.
  - `messaging.listConversations({ userId: "any-user-id" })` — reads anyone's conversations
  - `messaging.listMessages({ conversationId: "x", userId: "any-user-id" })` — reads any conversation if you know the conversationId and any participant's userId
  - `messaging.sendMessage({ conversationId: "x", senderId: "any-user-id" })` — send messages impersonating anyone
  - `scheduling.appointments.listByPatient({ patientId: "any-id" })` — no auth check at all
  - `notifications.getByUser({ userId: "any-id" })` — read anyone's notifications
- **Emergency access has no role restriction** (`services/auth/src/emergency-access.ts:25-29`). The `request` procedure accepts any `userId` — a patient could grant themselves emergency access to another patient's records. There is no check that the requester is a clinician.
- **Emergency access check is not integrated into RBAC.** The `assertPatientAccess` function (`services/api-gateway/src/middleware/rbac.ts:135-179`) does not consult the `emergencyAccess.check` query. A provider who uses break-the-glass will still get 403'd by the normal RBAC middleware.
- **Notification SSE endpoint trusts `request.userId`** (`services/api-gateway/src/routes/notifications-sse.ts:34`) which is set by auth middleware. This is correct but uses an unsafe cast `(request as unknown as { userId?: string }).userId` — if the property name changes or authMiddleware is refactored, this silently becomes `undefined` and returns 401 to all users.

### 5. HIPAA Compliance — Rating: 3/5

**Strengths:**
- Audit log is append-only at DB level (migration `0012_audit_log_immutability.sql`)
- Emergency access creates audit entries (`services/auth/src/emergency-access.ts:48-58`)
- PHI encryption at rest uses AES-256-GCM with key rotation support (`packages/db-schema/src/encryption.ts`)
- RBAC denials are audit-logged (`services/api-gateway/src/middleware/rbac.ts:12-33`)
- LLM prompts are redacted before transmission and the redacted prompt is persisted for breach forensics (`services/ai-oversight/src/services/review-service.ts:182-190`)
- PHI_HMAC_KEY is required in production, preventing encryption key reuse

**Weaknesses:**
- The messaging/scheduling/notification auth gap (Finding #1 above) is a HIPAA access control violation (45 CFR 164.312(a)(1))
- No audit logging on messaging access — conversations contain PHI but reads are not logged
- Emergency access audit entry (`services/auth/src/emergency-access.ts:57`) has `ip_address: ""` — always empty string. This defeats forensic investigation of unauthorized emergency access requests.
- The `notificationPreferences` endpoint (`services/notifications/src/router.ts:55-111`) has no auth — any user can view or modify another user's notification preferences
- Flag summaries in BullMQ payloads persist in Redis memory. If Redis is dumped (RDB/AOF backup), these contain clinical information without encryption.

---

## Top 5 Security/Reliability Findings

### Finding 1: CRITICAL — Messaging/Scheduling/Notifications Have Zero Authorization

**Severity:** P0 (exploitable, PHI exposure)
**Files:**
- `services/messaging/src/router.ts:22` — standalone `initTRPC.create()` with no context
- `services/scheduling/src/router.ts:15` — same pattern
- `services/notifications/src/router.ts:8` — same pattern
- `services/api-gateway/src/router.ts:27-29` — mounted directly without RBAC wrapper

**Impact:** Any authenticated user (including patients) can read any other user's messages, view any patient's appointments, and read any user's notifications by supplying arbitrary `userId`/`patientId` values. This is a full HIPAA breach vector.

**Recommendation:** Either (a) rewrite these routers to use the gateway's `Context` type and derive userId from the authenticated session, or (b) create RBAC wrapper routers (like `patient-records` has) that validate the caller's identity before delegating.

---

### Finding 2: HIGH — Read Receipt Race Condition (Lost Updates)

**Severity:** P2 (data integrity)
**File:** `services/messaging/src/router.ts:247-266`

**Evidence:**
```typescript
const readBy = (message.read_by ?? []) as string[];
if (!readBy.includes(input.userId)) {
  readBy.push(input.userId);
  await db.update(messages).set({ read_by: readBy }).where(eq(messages.id, input.messageId));
}
```

**Impact:** Concurrent `markRead` calls perform read-modify-write without a transaction or optimistic lock. Two providers reading the same message simultaneously can lose one's read receipt. In a clinical context, this means a provider may not appear to have read a critical message, triggering unnecessary escalation.

**Recommendation:** Use PostgreSQL `jsonb_set` or array append in a single atomic UPDATE: `UPDATE messages SET read_by = read_by || $1::jsonb WHERE id = $2 AND NOT read_by ? $1`

---

### Finding 3: HIGH — Rescheduling Is Not Transactional (Phantom Cancellation)

**Severity:** P2 (data integrity, patient safety)
**File:** `services/scheduling/src/router.ts:131-183`

**Impact:** The `reschedule` procedure cancels the original appointment, then checks for conflicts and inserts a new one. If the conflict check fails (time slot taken), the original is already cancelled — patient loses their appointment. If the insert fails due to a transient DB error, same outcome.

**Recommendation:** Wrap the entire reschedule operation in a single `db.transaction()`, just like the `create` procedure already does.

---

### Finding 4: HIGH — Emergency Access Not Integrated with RBAC

**Severity:** P2 (functionality gap, potential HIPAA violation)
**Files:**
- `services/auth/src/emergency-access.ts:22-65` — grants access
- `services/api-gateway/src/middleware/rbac.ts:135-179` — does not check emergency access

**Impact:** The break-the-glass feature creates records and audit entries but never actually grants access. A provider who correctly uses the emergency access flow will still receive 403 from the RBAC middleware. This means either (a) the feature is dead code, or (b) there is an undocumented bypass path.

**Recommendation:** Modify `assertPatientAccess` to check for active emergency access when the normal care-team check fails. Add the emergency access ID to the audit trail for each data access made under that grant.

---

### Finding 5: MEDIUM — PHI in BullMQ/Redis Payloads (Unencrypted at Rest in Memory)

**Severity:** P3 (defense-in-depth gap)
**Files:**
- `services/notifications/src/queue.ts:20-25` — `summary` field in notification events
- `services/ai-oversight/src/workers/escalation-worker.ts:84-94` — flag summary in queue payload
- `services/api-gateway/src/routes/notifications-sse.ts:99` — plaintext title in Redis pub/sub

**Impact:** Clinical flag summaries (e.g., "Patient reports chest pain in message", "Medication X matches allergy to Y") flow through Redis as plaintext JSON. Redis does not encrypt data at rest by default. An RDB dump, AOF file, or compromised Redis instance exposes clinical information without additional protection.

**Recommendation:** Use the `summary_safe` pattern already in the schema. Queue payloads should carry only IDs and PHI-safe metadata. Workers should fetch PHI from the encrypted DB only when needed for processing. For the SSE pub/sub channel, publish only the notification ID and let the client fetch the decrypted content via the authenticated tRPC endpoint.

---

## Additional Findings (Honorable Mentions)

| # | Severity | Finding | File:Line |
|---|----------|---------|-----------|
| 6 | MEDIUM | `ruleSequence` global counter in allergy-medication rule produces non-deterministic rule_ids across process restarts, breaking dedup | `services/ai-oversight/src/rules/allergy-medication.ts:116` |
| 7 | LOW | Emergency access audit log always has empty `ip_address: ""` | `services/auth/src/emergency-access.ts:57` |
| 8 | LOW | SSE creates unbounded Redis subscriber connections (one per client) | `services/api-gateway/src/routes/notifications-sse.ts:52` |
| 9 | LOW | No input length validation on message body beyond `z.string().min(1)` — potential for large payloads | `services/messaging/src/router.ts:175` |
| 10 | INFO | RBAC cache 5s TTL is documented trade-off; comment correctly identifies Redis-backed cache as proper fix | `services/api-gateway/src/middleware/rbac.ts:43` |

---

## Concrete Recommendations (Priority Order)

1. **Immediately** wrap messaging/scheduling/notifications in RBAC routers that derive userId from `ctx.user.id`. This is the single highest-impact fix.

2. **This week** integrate emergency access check into `assertPatientAccess`. Without this, the feature is theater.

3. **This week** wrap the reschedule procedure in a transaction. Copy the pattern from the existing `create` procedure on line 65 of the same file.

4. **This sprint** fix the read-receipt race with an atomic Postgres operation. Consider `UPDATE messages SET read_by = array_append(read_by, $1) WHERE id = $2 AND NOT ($1 = ANY(read_by))`.

5. **This sprint** strip PHI from BullMQ/Redis payloads. Replace `summary` with `flag_id` and have the notification worker look up the summary from the encrypted DB.

6. **Backlog** add connection pooling or max-connection limit for SSE Redis subscribers. Consider a shared subscriber that multiplexes across connected users.

---

## Type Safety: Package Boundary Contracts

**Rating: 3/5**

The monorepo uses `@carebridge/*` workspace packages with TypeScript strict mode. However:

- The messaging/scheduling/notifications routers create independent `initTRPC.create()` instances without the gateway's `Context` type. This means the type system cannot enforce that these routers have access to the authenticated user — the gap is invisible at compile time.
- The gateway's `appRouter` merges these routers without type errors because tRPC allows merging context-free routers into a context-aware parent. TypeScript does not flag this as a problem.
- `ClinicalEvent.data` is typed as `Record<string, unknown>`, requiring unsafe casts throughout the rules engine (e.g., `event.data.message_text as string`). A Zod-discriminated union per event type would provide compile-time safety.
- The `publishNotificationToUser` function in the SSE module accepts a plain object — there is no shared type ensuring it matches what the client expects. If the encrypted `title` from the DB is passed directly, the type system would not catch the PHI leak.

---

## Overall Rating: 3.0 / 5.0

**Verdict:** The marathon session delivered substantial functionality with thoughtful PHI-at-rest encryption, a solid clinical rules engine, and proper RBAC on the original service layer. However, the newly added services (messaging, scheduling, notifications) were built as standalone modules and bolted onto the gateway without the same RBAC treatment the older services received. The result is that any authenticated user — including patients — can access any other user's messages, appointments, and notifications by supplying arbitrary IDs. This is the kind of bug that passes code review because the individual service looks correct in isolation but becomes a HIPAA violation when composed. The emergency access feature is audit-theater until integrated with RBAC. The clinical safety rules are well-designed but have concurrency gaps under load. Fix the auth boundaries first — everything else is secondary until then.
