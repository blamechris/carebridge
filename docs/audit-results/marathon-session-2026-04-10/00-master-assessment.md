# Master Assessment: Marathon Session Swarm Audit

**Target:** 19 PRs (#339-#357) implementing notifications, messaging, clinical safety rules, patient portal, scheduling, and emergency access
**Date:** 2026-04-10
**Agents:** 8 (4 core + 4 extended)

---

## Auditor Panel

| Agent | Nickname | Rating | Key Contribution |
|-------|----------|--------|------------------|
| Skeptic | "Skeptic" | 3.0/5 | Found SSE dead code and message screening reading empty string |
| Builder | "Builder" | 3.5/5 | Identified ~40% of features with broken last-mile integration |
| Guardian | "Guardian" | 3.0/5 | Confirmed auth gaps across all new services |
| Minimalist | "Minimalist" | 3.0/5 | Found 20% of new code deletable with zero regression |
| Chart Keeper | "Chart Keeper" | 3.5/5 | Flagged string-matching vs RxNorm and observation schema gaps |
| Oversight | "Oversight" | 3.5/5 | Found patient.observation has zero deterministic rule coverage |
| Adversary | "Adversary" | 2.0/5 | Identified full user impersonation via client-supplied userId |
| Operator | "Operator" | 3.4/5 | Found patient lookup fallback exposes other patients' data |

**Aggregate Rating: 3.1/5** (core panel avg: 3.1, extended avg weighted 0.8x: 3.1)

---

## Consensus Findings (4+ agents agree)

### 1. CRITICAL — No RBAC wrappers on new services (7/8 agents)
**Agents:** Adversary, Guardian, Skeptic, Builder, Operator, Chart Keeper, Oversight

All new services (messaging, scheduling, notifications preferences, emergency access) accept `userId` as client input without validating it matches the authenticated caller. The original services (patient-records, clinical-data, clinical-notes) have RBAC wrapper routers in `services/api-gateway/src/routers/` — the new services skip this pattern entirely.

**Impact:** Any authenticated user can impersonate any other user — read messages, cancel appointments, suppress notifications, grant emergency access.

**Recommendation:** Create RBAC wrapper routers for messaging, scheduling, notifications, and emergency access in `services/api-gateway/src/routers/`. Derive userId from `ctx.user.id`, never from client input.

### 2. CRITICAL — Patient portal name-match lookup with fallback to data[0] (6/8 agents)
**Agents:** Operator, Skeptic, Builder, Adversary, Chart Keeper, Minimalist

All 6 patient portal pages use:
```ts
const myRecord = patientsQuery.data?.find(p => p.name === user?.name) ?? patientsQuery.data?.[0];
```
If the name doesn't match exactly, the fallback silently returns the first patient in the database — showing one patient another patient's clinical data.

**Impact:** HIPAA violation. PHI exposure across patients.

**Recommendation:** Link patient record to user account via a `patient_id` field on the `users` table, or a dedicated user-to-patient mapping. Never match by display name.

### 3. HIGH — SSE notifications are dead code (5/8 agents)
**Agents:** Skeptic, Builder, Guardian, Minimalist, Operator

The dispatch worker creates DB notification records but never calls `publishNotificationToUser()` to push to Redis pub/sub. The SSE endpoint subscribes to Redis channels that never receive messages. No frontend code connects to the SSE endpoint.

**Impact:** Real-time notification delivery is completely non-functional.

**Recommendation:** Add Redis publish call in dispatch worker after DB insert. Add EventSource connection in portal headers.

### 4. HIGH — Message screening reads empty string (5/8 agents)
**Agents:** Skeptic, Builder, Oversight, Guardian, Operator

We correctly removed PHI (message body) from the BullMQ event payload to avoid plaintext in Redis. But the message screening rule (`screenPatientMessage`) reads `event.data.message_text` which is now always undefined. Urgent symptom keywords (suicidal ideation, chest pain, stroke) are never matched.

**Impact:** The AI sentinel screening of patient messages — a core safety feature — is non-functional.

**Recommendation:** Message screening worker must read the message from DB (where Drizzle handles decryption) using the `message_id` from the event payload. The keyword screening runs against the decrypted text.

### 5. HIGH — Patient observations have no deterministic screening (4/8 agents)
**Agents:** Oversight, Skeptic, Builder, Chart Keeper

When a patient reports "worst headache ever" via the symptom journal, the `patient.observation` event goes through the review pipeline but only the LLM layer can catch it — there are no deterministic keyword rules for observations. The same symptoms in messages DO get keyword screening. If the LLM is unavailable (API down, rate limited), critical symptoms go completely undetected.

**Impact:** The core differentiator feature has a reliability gap — it depends entirely on LLM availability for safety-critical screening.

**Recommendation:** Apply the same `screenPatientMessage` keyword patterns to observation descriptions. Read description from DB (encrypted), run keyword screening, then optionally pass to LLM.

---

## Contested Points

### Emergency access: dead code vs. working design
- **Builder, Guardian** say it's dead code: RBAC middleware never checks `emergencyAccess.check()`, so providers still get 403.
- **Adversary** says the opposite problem: no role check means patients could use it too.
- **Assessment:** Both are right about different aspects. The schema and procedures are correct, but the integration point (RBAC middleware fallback to emergency access check) was never implemented.

### String matching vs. RxNorm for drug matching
- **Chart Keeper, Minimalist** say regex-based drug matching is unreliable and should use RxNorm codes.
- **Skeptic** notes it works for the curated list but won't scale to real clinical data.
- **Assessment:** The regex approach is appropriate for the deterministic "high-confidence" layer. RxNorm lookup should be added as an enhancement, not a replacement.

---

## Risk Heatmap

```
                    LOW IMPACT    MEDIUM        HIGH          CRITICAL
                  ┌─────────────┬─────────────┬─────────────┬─────────────┐
  VERY LIKELY     │             │ Schedule     │ Patient     │ RBAC gaps   │
                  │             │ placeholder  │ lookup      │ on new      │
                  │             │              │ fallback    │ services    │
                  ├─────────────┼─────────────┼─────────────┼─────────────┤
  LIKELY          │ Duplicate   │ Notif prefs  │ SSE dead    │ Message     │
                  │ severity    │ not enforced │ code        │ screening   │
                  │ inputs      │              │             │ empty str   │
                  ├─────────────┼─────────────┼─────────────┼─────────────┤
  POSSIBLE        │ ARIA gaps   │ ruleSequence │ Observation │ Emergency   │
                  │             │ collision    │ no determ.  │ access dead │
                  │             │              │ screening   │ code        │
                  ├─────────────┼─────────────┼─────────────┼─────────────┤
  UNLIKELY        │ Quiet hrs   │ Reschedule   │ markRead    │             │
                  │ suppress    │ race         │ race cond   │             │
                  │ critical    │              │             │             │
                  └─────────────┴─────────────┴─────────────┴─────────────┘
```

---

## Recommended Action Plan

### P0 — Fix before any user testing (1-2 days)

1. **Create RBAC wrappers** for messaging, scheduling, notifications, emergency access
   - Files: `services/api-gateway/src/routers/messaging.ts`, `scheduling.ts`, `emergency-access.ts`
   - Pattern: match existing `patient-records.ts`, `clinical-data.ts` wrappers
   - Derive userId from `ctx.user.id`

2. **Fix patient record lookup** across all 6 patient portal pages
   - Add `patient_id` to users table (migration), or create user-patient mapping
   - Replace name-match + fallback with direct ID lookup

3. **Fix message screening** to read from DB
   - In review worker, when event type is `message.received`, read message body from DB using `message_id`
   - Pass decrypted text to `screenPatientMessage()`

### P1 — Fix before production (2-3 days)

4. **Wire SSE delivery** — add Redis publish in dispatch worker, add EventSource in portal
5. **Add deterministic screening to patient observations** — reuse message screening keywords
6. **Wire emergency access into RBAC middleware** — check `emergencyAccess.check()` when standard assignment fails
7. **Fix ruleSequence** in allergy-medication.ts — use deterministic IDs based on allergen+medication pair

### P2 — Fix before scale (1-2 days)

8. **Add transactions** to messaging `markRead` and scheduling `reschedule`
9. **Enforce notification preferences** in dispatch worker
10. **Wire clinician schedule page** to real tRPC endpoint (remove placeholder data)
11. **Extract shared patient-lookup hook** for patient portal (DRY)

### P3 — Improve (ongoing)

12. Add ARIA attributes and keyboard navigation to portal pages
13. Add RxNorm lookup as supplement to regex drug matching
14. Add FHIR R4 alignment to patient observations schema
15. Add Claude-specific prompt injection patterns to sanitizer

---

## Final Verdict

**Aggregate Rating: 3.1/5 — Adequate with critical integration gaps.**

The marathon session produced architecturally sound backend services: well-structured BullMQ workers with DLQ patterns, proper PHI encryption at rest, clinically appropriate screening rules, and a solid scheduling service with transaction-protected double-booking prevention. The clinical safety rules (20 drug interaction pairs, 13 allergy cross-reactivity classes, 10 urgent symptom patterns) represent genuine domain value that traditional EHR systems lack.

However, the speed of implementation left critical integration seams: new services lack RBAC wrappers (the single most urgent fix), the patient portal uses a dangerous name-match lookup pattern, two safety-critical paths (SSE notifications and message screening) are functionally dead code, and the core differentiator feature (patient symptom journal) has no deterministic safety net. The P0 fixes are estimated at 1-2 focused days and must be completed before any user testing. After those fixes, the platform would rate 4.0+/5 — a genuinely differentiated healthcare platform with AI safety features that Epic MyChart fundamentally lacks.

---

## Appendix — Individual Reports

| File | Agent | Rating |
|------|-------|--------|
| [01-skeptic.md](01-skeptic.md) | Skeptic | 3.0/5 |
| [02-builder.md](02-builder.md) | Builder | 3.5/5 |
| [03-guardian.md](03-guardian.md) | Guardian | 3.0/5 |
| [04-minimalist.md](04-minimalist.md) | Minimalist | 3.0/5 |
| [05-chart-keeper.md](05-chart-keeper.md) | Chart Keeper | 3.5/5 |
| [06-oversight.md](06-oversight.md) | Oversight | 3.5/5 |
| [07-adversary.md](07-adversary.md) | Adversary | 2.0/5 |
| [08-operator.md](08-operator.md) | Operator | 3.4/5 |
