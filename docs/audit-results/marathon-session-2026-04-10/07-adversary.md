# Adversary Audit: Marathon Session Security Review

**Date:** 2026-04-10
**Scope:** 19 PRs merged — messaging, scheduling, emergency access, notifications, SSE, patient portal
**Auditor Role:** Attack surface, abuse cases, authorization bypass, data exfiltration, injection

---

## Area Ratings

| Area | Rating (1-5) | Summary |
|------|:---:|---------|
| Messaging Service | 2/5 | Client-supplied userId trusted for authz; no care-team validation on conversation creation |
| Emergency Access | 2/5 | No role restriction; no rate limit; justification bar trivially low |
| Notification Preferences | 2/5 | Any authenticated user can modify any other user's preferences |
| Scheduling | 2/5 | No authz checks at all; any user can book/cancel/view any appointment |
| Patient Portal (name-match) | 3/5 | Fragile identity resolution; RBAC on backend prevents cross-patient access for patients |
| Refill Workflow | 3/5 | Bounded by messaging authz (still weak); message body is free-text |
| SSE Endpoint | 4/5 | Properly gated by auth middleware; per-IP rate limit applies; no connection cap per user |

---

## Top 5 Exploitable Vulnerabilities

### 1. CRITICAL: Client-Supplied userId Enables Full Impersonation (Messaging, Notifications, Scheduling)

**Evidence:**
- `services/messaging/src/router.ts:39` — `listConversations` accepts `{ userId: z.string() }` from client input
- `services/messaging/src/router.ts:64` — `getConversation` accepts `{ conversationId, userId }` from client
- `services/messaging/src/router.ts:139` — `listMessages` accepts `{ conversationId, userId }` from client
- `services/messaging/src/router.ts:176` — `sendMessage` accepts `{ senderId: z.string() }` from client
- `services/notifications/src/router.ts:12` — `getByUser` accepts `{ userId: z.string() }` from client
- `services/notifications/src/router.ts:55` — `getPreferences` accepts `{ userId: z.string() }` from client
- `services/notifications/src/router.ts:63` — `updatePreference` accepts `{ userId: z.string() }` from client

**Root Cause:** These routers create their own `initTRPC.create()` instance (no context), so they have NO access to `ctx.user`. They rely entirely on the client to pass the correct `userId`. The gateway at `services/api-gateway/src/router.ts:7-8` imports and mounts these routers directly without wrapping them in a protected procedure or injecting context.

**Attack Scenario:**
1. Attacker authenticates as `patient@carebridge.dev`
2. Calls `messaging.listConversations({ userId: "<dr.smith's-uuid>" })`
3. Receives all of Dr. Smith's conversations (with PHI from all patients)
4. Calls `messaging.listMessages({ conversationId: "...", userId: "<dr.smith's-uuid>" })` to read message content
5. Calls `messaging.sendMessage({ conversationId: "...", senderId: "<dr.smith's-uuid>", body: "..." })` to impersonate the doctor

**Impact:** Complete PHI breach. Any authenticated user can read/write messages as any other user. HIPAA violation.

---

### 2. HIGH: No Care-Team Validation on Conversation Creation — Patient Can Message Any User

**Evidence:**
- `services/messaging/src/router.ts:98-133` — `createConversation` accepts arbitrary `participantIds` array
- No validation that participants are on the patient's care team
- No validation that the caller's role permits creating conversations with the specified participants

**Attack Scenario:**
1. Patient creates conversation with `participantIds: ["<any-provider-uuid>"]`
2. Provider receives unsolicited messages from an unrelated patient
3. More critically: a malicious user could add themselves to conversations they shouldn't be in by specifying their own ID in `participantIds` for another patient's record

**Impact:** Breaks care-team communication boundary. Enables social engineering of providers.

---

### 3. HIGH: Emergency Access Has No Role Restriction or Rate Limiting

**Evidence:**
- `services/auth/src/emergency-access.ts:25-65` — `request` procedure accepts `{ userId, patientId, justification }` with only a 10-character minimum on justification
- No role check: a patient can request emergency access to another patient's record
- No rate limit beyond the global 100 req/min (can access 100 patient records per minute)
- `services/auth/src/emergency-access.ts:115-122` — `listAll` exposes the entire emergency access history to any caller (no role check)

**Attack Scenario:**
1. Attacker (any authenticated role, including patient) calls `emergencyAccess.request({ userId: "<their-id>", patientId: "<victim>", justification: "emergency situation" })`
2. Gains 4-hour access window to victim's records
3. Repeats for every patient UUID they can enumerate
4. Calls `emergencyAccess.listAll({})` to see all historical emergency access events (privacy leak)

**Impact:** Complete bypass of care-team access controls. Audit trail exists but no preventive control.

---

### 4. HIGH: Scheduling Router Has Zero Authorization — Any User Can Cancel/Reschedule Any Appointment

**Evidence:**
- `services/scheduling/src/router.ts:17` — All procedures use bare `t.procedure` (no auth, no context)
- `services/scheduling/src/router.ts:20-27` — `listByPatient` accepts any `patientId`; no access check
- `services/scheduling/src/router.ts:30-47` — `listByProvider` exposes any provider's full schedule
- `services/scheduling/src/router.ts:100-121` — `cancel` accepts any `appointmentId` and `cancelledBy` (attacker-supplied)
- `services/scheduling/src/router.ts:126-184` — `reschedule` same issue; cancel + recreate with no ownership check
- `services/scheduling/src/router.ts:276-303` — `setProviderSchedule` allows anyone to modify any provider's schedule template

**Attack Scenario:**
1. Enumerate all patient appointments via `listByPatient`
2. Cancel critical appointments: `cancel({ appointmentId: "...", cancelledBy: "<victim-id>", reason: "no longer needed" })`
3. Modify provider schedule templates to block all availability
4. DoS attack: reschedule all appointments to same time slot (prevented only by overlap check, but attacker can spread across days)

**Impact:** Availability attack on healthcare delivery. Patient safety risk if critical follow-ups are cancelled.

---

### 5. MEDIUM: Notification markRead Has No Ownership Check — IDOR

**Evidence:**
- `services/notifications/src/router.ts:24-31` — `markRead` accepts `{ id: z.string() }` with no user verification
- Any authenticated user can mark any notification (belonging to any other user) as read

**Attack Scenario:**
1. Attacker obtains or guesses notification UUIDs (or enumerates via `getByUser` with victim's userId per vuln #1)
2. Marks all clinical flag notifications as read before the provider sees them
3. Provider never realizes they have an urgent AI oversight flag to review

**Impact:** Suppression of clinical safety alerts. Patient harm if critical flags (e.g., DVT/stroke risk) go unnoticed.

---

## Additional Findings

### 6. Notification `create` Endpoint Exposed Without Role Check
- `services/notifications/src/router.ts:33-53` — Any authenticated user can create notifications targeting any user
- Enables spam/phishing within the platform (fake "urgent" notifications with malicious links)

### 7. Message `markRead` Missing Participation Check
- `services/messaging/src/router.ts:242-267` — `markRead` checks only that the message exists, not that `input.userId` is a participant
- Any user can mark any message as read, potentially hiding messages from the intended recipient's unread view

### 8. Patient Portal Name-Match Identity Resolution
- `apps/patient-portal/app/page.tsx:32-34` — Uses `patients.list` which correctly blocks patients with RBAC
- However, the fallback pattern `?? patientsQuery.data?.[0]` means if the name match fails, the first returned patient is used
- For non-patient roles (e.g., nurse accessing patient portal), this could expose the wrong patient's data

### 9. Refill Workflow Free-Text Injection
- `apps/patient-portal/app/refill/page.tsx:76-82` — Message body is constructed from medication data + user-supplied `note`
- No sanitization of the `note` field; while XSS risk is low (React escapes), the body goes to AI oversight (`clinicalEventsQueue`)
- An attacker could craft a note designed to manipulate the AI oversight prompt (prompt injection via clinical event)

### 10. SSE Connection Flooding (Minor)
- `services/api-gateway/src/routes/notifications-sse.ts:52` — Each connection creates a dedicated Redis subscriber
- No per-user connection limit; attacker with valid session could open hundreds of SSE connections
- Each spawns a Redis connection, potentially exhausting Redis connection pool

---

## Evidence Summary Table

| File | Line | Issue |
|------|------|-------|
| `services/messaging/src/router.ts` | 39, 64, 139, 176 | Client-supplied userId, no ctx.user validation |
| `services/messaging/src/router.ts` | 98-133 | No care-team check on participant list |
| `services/messaging/src/router.ts` | 242-267 | markRead no participation check |
| `services/scheduling/src/router.ts` | 17-303 | Entire router has zero authorization |
| `services/auth/src/emergency-access.ts` | 25-65 | No role restriction on emergency access requests |
| `services/auth/src/emergency-access.ts` | 115-122 | listAll exposes all events to any caller |
| `services/notifications/src/router.ts` | 24-31 | markRead IDOR, no ownership check |
| `services/notifications/src/router.ts` | 33-53 | create exposed to all, no role check |
| `services/notifications/src/router.ts` | 63-111 | updatePreference accepts arbitrary userId |
| `services/api-gateway/src/routes/notifications-sse.ts` | 52 | No per-user connection limit |
| `services/api-gateway/src/router.ts` | 7-8 | Vulnerable routers mounted without auth wrapper |

---

## Overall Rating: 2/5 — CRITICAL DEFICIENCIES

**Verdict:** The messaging, scheduling, notifications, and emergency access services share a single catastrophic architectural flaw: they instantiate their own tRPC routers with `initTRPC.create()` (no context type) and accept user identity as a client-supplied input parameter rather than deriving it from the authenticated session. The API gateway mounts these routers without any middleware wrapper that would enforce `ctx.user` matching. This means any authenticated user can impersonate any other user across these services — reading PHI, sending messages as doctors, cancelling appointments, granting themselves emergency access, and suppressing clinical safety notifications. In a healthcare context handling PHI, this represents a HIPAA-level breach waiting to happen. The double-booking prevention in scheduling (transaction-based overlap check) and the SSE auth check are bright spots, but they are overshadowed by the fundamental authz bypass in every service router that was added during this sprint. Immediate remediation: all service routers must use the gateway's context-aware tRPC instance and derive userId from `ctx.user.id`, never from client input.
