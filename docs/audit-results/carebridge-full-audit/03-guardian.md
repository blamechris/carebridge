# Guardian's Audit: CareBridge Full Codebase

**Agent**: Guardian — paranoid security/SRE; safety, failure modes, HIPAA compliance
**Overall Rating**: 2.5 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| PHI encryption at rest | 4/5 | AES-256-GCM field-level; patient name gap |
| PHI in transit / headers | 2/5 | No TLS enforcement, no security headers |
| Session security | 3/5 | JWT + DB revocation; dev bypass and in-memory MFA are risks |
| Audit logging completeness | 2/5 | HTTP verb only; tRPC bodies not logged; patient ID not captured |
| BullMQ failure handling | 2/5 | No DLQ, no retries, no removeOnFail |
| Database transaction safety | 3/5 | Lab panel correct; write-then-emit split-brain possible |
| AI oversight reliability | 3/5 | review_jobs tracks failures; permanent failure loses event |
| Error handling / secrets | 3/5 | tRPC surfaces messages; PHI logs to stdout |
| CORS | 1/5 | `origin: true` with credentials — reflects any origin |
| Rate limiting | 2/5 | MFA has in-memory rate limit; login has none; API has none |

---

## Top 5 Findings

### Finding 1 — CRITICAL: CORS Configured to Reflect Any Origin

**File:** `services/api-gateway/src/server.ts:20-23`

```ts
await server.register(cors, {
  origin: process.env.CORS_ORIGIN ?? true,
  credentials: true,
});
```

`origin: true` reflects the incoming `Origin` header with `Access-Control-Allow-Credentials: true`. This is the textbook CSRF vector — any attacker-controlled web page can send credentialed requests to the API and receive all PHI. The dangerous fallback is active whenever `CORS_ORIGIN` is unset.

**Fix:** Replace `?? true` with an explicit allowlist. Fail-closed: refuse to start if `CORS_ORIGIN` is absent in production.

---

### Finding 2 — CRITICAL: Dev Auth Bypass Never Gated Properly

**File:** `services/api-gateway/src/middleware/auth.ts:43,58-86`

```ts
const isDevMode = process.env.NODE_ENV !== "production";
if (isDevMode) {
  const devUserId = request.headers["x-dev-user-id"] as string | undefined;
  if (devUser) { return; }   // full bypass, no JWT
  // fallback: DB lookup of any user ID — also bypasses JWT
```

Staging/CI/preview environments running without `NODE_ENV=production` get a zero-credential admin takeover. The DB fallback path impersonates any real user ID without a token.

**Fix:** Remove the `x-dev-user-id` path entirely. If needed, gate on an explicit `ALLOW_DEV_HEADER=true` var that cannot be set in CI/staging pipelines.

---

### Finding 3 — HIGH: BullMQ Has No Retry Config, No DLQ

**Files:** `services/clinical-data/src/events.ts:14-20`, `services/ai-oversight/src/workers/review-worker.ts:23-59`

Default BullMQ behavior is 0 automatic retries. A DVT stroke-risk rule firing on a transient DB blip fails silently. No DLQ, no alert, no human review path. The failed set grows unboundedly, causing Redis memory pressure.

**Fix:** Set `attempts: 5` with exponential backoff. Configure `removeOnFail: { count: 10000 }`. Alert on any failed job in `clinical-events`.

---

### Finding 4 — HIGH: In-Memory MFA State (Sessions + Rate Limiter)

**Files:** `services/auth/src/router.ts:77-80`, `services/auth/src/mfa-rate-limit.ts:18`

Both the pending MFA sessions and the brute-force rate-limit counter live in process memory. Any restart or horizontal scale wipes them. An attacker can reset rate limits by triggering a service crash. Multi-instance deployments get N×5 effective brute-force attempts.

**Fix:** Move `pendingMFASessions` and `mfaAttempts` to Redis with TTL. Redis is already in the stack.

---

### Finding 5 — HIGH: No Rate Limiting on Login or API Gateway

**File:** `services/api-gateway/src/server.ts` (no rate limit plugin)

The login endpoint has no rate limit. At 30ms per scrypt check, that's ~3300 attempts/second at 100 concurrent connections. No API-level throttling on PHI endpoints either.

**Fix:** Add `@fastify/rate-limit` with at least `max: 5, timeWindow: 60000` on `/trpc/auth.login`. Redis-backed so it works across replicas.

---

## Additional Findings

| Finding | File | Line | Severity |
|---|---|---|---|
| `createUser` unauthenticated | `services/auth/src/router.ts` | 457 | Medium |
| Audit log missing patient ID | `services/api-gateway/src/middleware/audit.ts` | 32-50 | Medium |
| Redis no TLS/auth | `docker-compose.yml` | 17-30 | Medium |
| PHI in LLM prompt unredacted | `services/ai-oversight/src/workers/context-builder.ts` | 193 | Medium |
| `patients.name` plaintext | `packages/db-schema/src/schema/patients.ts` | 6 | Medium |
| `refresh_token` plaintext in DB | `packages/db-schema/src/schema/auth.ts` | 26 | Low |
| AI oversight router no auth | `services/ai-oversight/src/router.ts` | 21-22 | Medium |
| JWT default secret accepted | `services/auth/src/jwt.ts` | 22 | Low |

---

## Overall Rating: 2.5/5

CareBridge has a thoughtful security architecture (AES-256-GCM, JWT+revocation, scrypt, MFA, care-team RBAC, PHI sanitizer) but several gaps turn it into swiss cheese. The CORS wildcard-reflect-with-credentials is a textbook credential theft vector. The dev-header bypass is a zero-credential admin takeover on any non-production environment. BullMQ has no retry/DLQ so the DVT stroke-risk flag can vanish on any transient blip. The AI oversight router has no auth — anyone can dismiss a critical clinical flag. Must not go to production without addressing the top 5 findings.
