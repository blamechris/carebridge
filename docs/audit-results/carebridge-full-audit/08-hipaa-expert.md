# HIPAA Expert's Audit: CareBridge Full Platform

**Agent**: HIPAA Expert — Healthcare compliance specialist, 45 CFR Part 164
**Overall Rating**: 1.5 / 5
**Date**: 2026-04-05

## HIPAA Safeguard Ratings

| Requirement | Regulation | Rating | Type |
|---|---|---|---|
| Unique User Identification | §164.312(a)(1) | 2/5 | Required |
| Emergency Access Procedure | §164.312(a)(2)(i) | 1/5 | Required |
| Automatic Logoff | §164.312(a)(2)(iii) | 1/5 | Addressable |
| Audit Controls | §164.312(b) | 2/5 | Required |
| Integrity Controls | §164.312(c)(1) | 2/5 | Required |
| Person/Entity Authentication | §164.312(d) | 2/5 | Required |
| Transmission Security | §164.312(e)(1) | 2/5 | Required |
| Activity Review | §164.308(a)(1)(ii)(D) | 2/5 | Required |
| BAA — Anthropic Claude API | §164.308(b)(1) | 1/5 | Required |
| Access Control / Min. Necessary | §164.312(a)(2)(ii) | 2/5 | Required |
| Encryption at Rest | §164.312(a)(2)(iv) | 1/5 | Addressable |
| Password Management | §164.308(a)(5)(ii)(D) | 1/5 | Addressable |

## Top 5 HIPAA Compliance Gaps

### Gap 1 — Plaintext Password Storage [§164.312(d) — REQUIRED]
`services/auth/src/router.ts:39-47` — `"hashed:" + password` prefix. All credentials recoverable from DB. No bcrypt/argon2 dependency exists. Required safeguard, direct violation.

### Gap 2 — Authentication Bypass via Header [§164.312(a)(1), §164.312(d) — REQUIRED]
`services/api-gateway/src/middleware/auth.ts:41` — `NODE_ENV !== "production"` gates full auth bypass. Single header = admin impersonation with no credentials. Audit log records attacker's chosen identity, not true requester.

### Gap 3 — PHI to Anthropic Without BAA [§164.308(b)(1) — REQUIRED]
`services/ai-oversight/src/services/claude-client.ts` + `context-builder.ts:30-203` — Full patient PHI (diagnoses, meds, vitals, labs, care team names) transmitted to Anthropic API. No de-identification. No BAA confirmation in code, config, or documentation. One of the most commonly cited HIPAA enforcement actions.

### Gap 4 — No Automatic Logoff [§164.312(a)(2)(iii) — ADDRESSABLE]
`services/auth/src/router.ts:33` — 24-hour hard TTL, no activity-based timeout. Sessions table has no `last_active_at` column. Clinical workstations are routinely shared; 24-hour unattended sessions are unacceptable.

### Gap 5 — No RBAC on Data Endpoints [§164.312(a)(1), §164.514(b) — REQUIRED]
`services/patient-records/src/router.ts:35-38` — `list` returns ALL patients, no filter. `clinical-notes/src/router.ts:14` — `initTRPC.create()` — no auth context. All PHI accessible to any authenticated (or unauthenticated) user.

## Additional Compliance Issues

- **§164.312(b) Audit Controls**: `resource_id = ""` for all tRPC calls; `details` column never populated; no patient identified in audit trail
- **§164.312(e)(1) Transmission Security**: No TLS on API gateway; DB connection string has no SSL config; Redis PHI in plaintext; CORS wildcard with `credentials: true`
- **§164.312(a)(2)(iv) Encryption at Rest**: No column encryption on any PHI field; DB uses default postgres image with no TDE
- **§164.312(a)(2)(i) Emergency Access**: Dev bypass is not a compliant break-glass procedure — no justification capture, no time-limiting, no separate audit trail
- **§164.308(a)(1)(ii)(B) Risk Management**: DB credentials hardcoded as fallback `carebridge_dev`; Redis unauthenticated on port 6379

## Remediation Priority

| Priority | Action | Effort | Impact |
|---|---|---|---|
| P0 — Block deployment | Execute BAA with Anthropic | Contractual | HIPAA §164.308(b)(1) violation |
| P0 — Block deployment | Replace placeholder password hashing (bcrypt/argon2) | Low | §164.312(d) |
| P0 — Block deployment | Remove x-dev-user-id bypass | Low | §164.312(a)(1) |
| P1 — Pre-launch | RBAC on all service routers | Medium | §164.312(a)(1) + Privacy Rule |
| P1 — Pre-launch | Add last_active_at + inactivity timeout (15 min) | Low | §164.312(a)(2)(iii) |
| P1 — Pre-launch | Redis requirepass + TLS + internal-only | Low | §164.312(e)(1) |
| P1 — Pre-launch | PHI de-identification before LLM calls | Medium | §164.308(b)(1) |
| P2 — 30 days | Enrich audit log with resource IDs and details | Medium | §164.312(b) |
| P2 — 30 days | Implement break-glass emergency access procedure | Medium | §164.312(a)(2)(i) |
| P3 — 90 days | Column encryption for PII/PHI fields | Medium | §164.312(a)(2)(iv) |
| P3 — 90 days | MFA for clinician accounts | Medium | §164.308(a)(5)(ii)(D) |

## Overall Rating: 1.5/5

CareBridge has the structural foundations for compliance (audit log schema, session management, role definitions) but has multiple Required safeguard gaps that constitute direct HIPAA violations. Before any PHI can be processed: (1) execute BAA with Anthropic, (2) implement real password hashing, (3) remove the header auth bypass. Three items, hours of engineering effort, maximum legal/safety risk.
