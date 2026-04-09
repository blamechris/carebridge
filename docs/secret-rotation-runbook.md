# Secret Rotation Runbook

## Why this runbook exists

The `.env` file was tracked in git history before commit `bd1f...` removed it
and added it to `.gitignore`. Historical commits still contain values for:

- `PHI_ENCRYPTION_KEY` — AES-256-GCM key for field-level PHI encryption
- `PHI_HMAC_KEY` — HMAC-SHA-256 key for deterministic blind-index columns
- `JWT_SECRET` — HS256 signing key for session tokens
- `REDIS_PASSWORD` — Redis auth for BullMQ + cache
- `SESSION_SECRET` — cookie signing key

Because we do NOT rewrite shared git history (destructive, breaks every
cloned checkout), these values must be treated as **compromised** and
rotated out of every environment in which they were ever used.

This runbook is the single source of truth for how to perform that
rotation safely. It also covers ongoing rotation hygiene after the
one-time remediation is complete.

## Rotation cadence

| Secret | One-time remediation | Ongoing cadence | Emergency |
|--------|---------------------|-----------------|-----------|
| `PHI_ENCRYPTION_KEY` | Required before any prod PHI | Annually | On suspected compromise or staff departure with access |
| `PHI_HMAC_KEY` | Required before any prod PHI | Annually, aligned with `PHI_ENCRYPTION_KEY` | On suspected compromise |
| `JWT_SECRET` | Required before any prod traffic | Quarterly | On suspected compromise; invalidates all live sessions |
| `REDIS_PASSWORD` | Required before any prod traffic | Quarterly | On suspected compromise |
| `SESSION_SECRET` | Required before any prod traffic | Quarterly, aligned with `JWT_SECRET` | On suspected compromise |

Every rotation — scheduled or emergency — is recorded in
`docs/secret-rotation-log.md` with the date, operator, rotated key labels
(never values), and the reason.

## General principles

1. **Never log secret values.** All scripts in this runbook emit counts
   and column labels only. If you need to diff, diff fingerprints (first
   8 bytes of SHA-256), not raw values.
2. **Generate secrets with a CSPRNG.** Use
   `openssl rand -hex 32` for 256-bit keys. Do NOT hand-type them.
3. **Dual-key windows where possible.** Keep the previous value available
   as `*_PREVIOUS` during re-encryption / session transition so the
   rotation does not cause a hard outage.
4. **Rotate in staging first.** Prove the runbook in staging before
   touching prod. Staging must be a faithful replica: same PHI column
   set, same migration level.
5. **Back up the database before PHI key rotation.** A failed
   re-encryption with no backup can brick every PHI column. Take a full
   snapshot immediately before running `rotate-keys.ts` and verify the
   snapshot is restorable.
6. **Update the secret store, not `.env`.** In prod, secrets live in the
   managed secret store (AWS Secrets Manager / GCP Secret Manager / 1Password
   vault — depending on environment). The runbook below references the
   store-agnostic step "update secret manager"; substitute the concrete
   tool for your environment.

## Rotation procedures

### 1. `PHI_ENCRYPTION_KEY` (highest blast radius — follow exactly)

Rotating `PHI_ENCRYPTION_KEY` requires **re-encrypting every field-encrypted
column** with the new key. If the key is rotated without re-encryption, all
existing ciphertexts become unreadable.

**Prereqs:**
- Database snapshot taken within the last 15 minutes, verified restorable.
- Staging rotation completed and smoke-tested within the last 7 days.
- On-call engineer ack'd and standing by.
- No active writes to PHI columns for the duration (maintenance window or
  read-only mode). The re-encryption script is not write-safe against
  concurrent mutations.

**Steps:**

1. Generate the new key:
   ```bash
   openssl rand -hex 32
   ```
   Store it in the secret manager as `PHI_ENCRYPTION_KEY_NEW` (temporary
   label). Do NOT overwrite `PHI_ENCRYPTION_KEY` yet.

2. Expose both keys to the rotation script only:
   ```bash
   export PHI_ENCRYPTION_KEY="<new-64-hex>"
   export PHI_ENCRYPTION_KEY_PREVIOUS="<old-64-hex>"
   export DATABASE_URL="<prod-url>"
   ```
   These variables live in the operator's shell session only; they are
   never written to disk.

3. Put the application into maintenance mode (blocks new writes).
   Confirm `clinical-events` BullMQ queue is drained.

4. Run the rotation:
   ```bash
   pnpm --filter @carebridge/db-schema exec \
     tsx src/rotate-keys.ts
   ```
   The script walks every PHI column in `patients`, `clinical_notes`,
   `note_versions`, `diagnoses`, `allergies`, `medications`, and any
   other table registered in `MIGRATION_0011_TARGETS`. For each row it
   decrypts with fallback (new key → old key) and re-encrypts with the
   new key. Rows already on the new key are skipped.

5. Verify row counts in the script output match the expected totals. A
   mismatch (rows skipped as "unreadable") means a row exists that neither
   key can decrypt — STOP and restore from snapshot.

6. Swap the secret manager:
   - Promote `PHI_ENCRYPTION_KEY_NEW` → `PHI_ENCRYPTION_KEY`.
   - Archive the old value as `PHI_ENCRYPTION_KEY_ARCHIVE_YYYYMMDD` with
     a 30-day retention marker (for emergency rollback).

7. Restart every service that reads `PHI_ENCRYPTION_KEY`:
   `api-gateway`, `clinical-notes`, `clinical-data`, `ai-oversight`,
   `patient-records`, `auth`. Confirm each comes up healthy.

8. Take a smoke-test sample: read one patient row from each encrypted
   table in the clinician portal. Successful reads confirm the rotation.

9. Exit maintenance mode.

10. Record the rotation in `docs/secret-rotation-log.md`.

**Rollback:**
If step 8 fails, re-export the previous value as `PHI_ENCRYPTION_KEY`,
restart services, confirm reads recover, then restore the database
snapshot to undo any partial re-encryption. Investigate before retrying.

### 2. `PHI_HMAC_KEY`

`PHI_HMAC_KEY` underlies deterministic blind-index columns (used by
searchable-encryption patterns). Rotating it requires re-computing every
HMAC index.

**Steps:**

1. Confirm whether any columns currently depend on the HMAC (check
   `packages/db-schema/src/encryption.ts` for `hmacDeterministic` usage).
   As of this writing, MFA secret lookups and MRN blind-index use it.

2. Follow the same dual-key pattern as `PHI_ENCRYPTION_KEY`: set
   `PHI_HMAC_KEY_PREVIOUS` to the old value, `PHI_HMAC_KEY` to the new.

3. Re-generate the blind-index columns. No standalone script exists yet
   because the column surface is small; current procedure is to run the
   targeted `UPDATE ... SET index = hmac(new_key, cleartext)` queries
   via the rotation session. **If the blind-index surface grows, this
   runbook must be upgraded with a dedicated script.**

4. Promote, restart services, smoke-test MRN lookup in clinician portal.

5. Record in `docs/secret-rotation-log.md`.

### 3. `JWT_SECRET`

Rotating `JWT_SECRET` invalidates every live session. Schedule during a
low-traffic window and communicate to users (or force re-login silently).

**Steps:**

1. Generate the new secret: `openssl rand -hex 32`.

2. Deploy the new value to all services that verify JWTs:
   `api-gateway`, `auth`, any portal that decodes tokens client-side.
   Services read `JWT_SECRET` at boot, so every service must restart.

3. Accept short-lived dual verification (optional): if the
   `jwt.ts` verifier supports `JWT_SECRET_PREVIOUS`, set it to the old
   value for a grace window (<= 10 minutes — matches session idle
   timeout). Otherwise skip this step and expect all users to re-login.

4. Restart services in order: `auth` → `api-gateway` → portals.

5. Smoke-test: log in as `dr.smith@carebridge.dev` in staging, confirm
   session works end-to-end.

6. Remove `JWT_SECRET_PREVIOUS` after the grace window.

7. Record in `docs/secret-rotation-log.md`.

### 4. `REDIS_PASSWORD`

BullMQ, rate-limiter, and the RBAC cache all connect through Redis.
Rotating the password requires a coordinated swap on both the server and
every client.

**Steps:**

1. Generate the new password: `openssl rand -hex 32`.

2. Add the new password to Redis as a second valid ACL user (Redis >= 6
   supports multiple users). Example:
   ```
   ACL SETUSER carebridge on >$NEW_PASSWORD ~* +@all
   ```
   This lets both old and new credentials authenticate during the swap.

3. Update the secret manager: `REDIS_PASSWORD` → new value.

4. Rolling-restart every service that connects to Redis: `api-gateway`,
   `ai-oversight` worker, `notifications`, `clinical-notes`,
   `clinical-data`, `patient-records`. One service at a time; verify
   reconnect before moving to the next.

5. Once all services are on the new password, remove the old ACL entry:
   ```
   ACL DELUSER carebridge_old
   ```

6. Confirm the `clinical-events` queue is processing events and no
   worker is in a reconnect loop.

7. Record in `docs/secret-rotation-log.md`.

### 5. `SESSION_SECRET`

`SESSION_SECRET` signs session cookies. Rotating it invalidates all
existing cookies — behavior is identical to `JWT_SECRET` rotation.

**Steps:**

1. Generate the new secret: `openssl rand -hex 32`.

2. Deploy to all services that sign or verify session cookies
   (currently `api-gateway`). Restart.

3. Smoke-test: log out / log in cycle in staging.

4. Record in `docs/secret-rotation-log.md`.

## Rotation checklist (quick reference)

Use this checklist for each rotation event:

- [ ] Reason documented (scheduled / emergency / initial remediation)
- [ ] Database snapshot taken (if rotating `PHI_ENCRYPTION_KEY` or `PHI_HMAC_KEY`)
- [ ] New secret generated with `openssl rand -hex 32`
- [ ] Staging rotation completed within last 7 days
- [ ] On-call engineer notified
- [ ] Maintenance window opened (if required)
- [ ] BullMQ queue drained (if required)
- [ ] Rotation script executed
- [ ] Row counts / success metrics verified
- [ ] Secret manager updated
- [ ] All dependent services restarted
- [ ] Smoke test passed
- [ ] Maintenance window closed
- [ ] Rotation log entry created in `docs/secret-rotation-log.md`
- [ ] Old secret archived with retention marker

## Out of scope

- **Rewriting git history** to remove leaked values. Per the project-level
  security notice in `CLAUDE.md`, history is preserved to avoid
  destructive shared-branch operations. Rotation is the mitigation.
- **Per-tenant keys.** CareBridge currently uses a single-tenant key
  model. Per-tenant keys are a future requirement that will need a new
  rotation procedure.
- **HSM integration.** Keys are currently managed in the environment /
  secret manager layer. Moving to an HSM is a separate hardening task
  and will change every procedure in this runbook.

## Owners

- Primary owner: security engineer on-call rotation.
- Backup owner: CTO.
- Audit reviewer: privacy officer (reviews `secret-rotation-log.md`
  quarterly).
