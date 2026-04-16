# PHI Encryption Key Rotation Runbook

Audience: CareBridge on-call engineer or security lead executing a planned
rotation of `PHI_ENCRYPTION_KEY`. Covers routine rotation and emergency
rotation (suspected compromise).

## Background

CareBridge encrypts PHI columns with AES-256-GCM using a 32-byte key
supplied via `PHI_ENCRYPTION_KEY` (hex-encoded). The Drizzle custom type
(`packages/db-schema/src/encryption.ts`) reads `PHI_ENCRYPTION_KEY` at
runtime. A second env var, `PHI_ENCRYPTION_KEY_PREVIOUS`, acts as a
decryption fallback so rotation can be gradual — rows still encrypted
under the old key remain readable while they are being re-encrypted under
the new key.

HMAC indexes (e.g. `mrn_hmac`) use a separate key, `PHI_HMAC_KEY`. HMAC
keys MUST NOT be rotated with the same procedure below — rotating the
HMAC key invalidates every indexed lookup and requires a separate
migration. This runbook does not cover HMAC rotation.

## When to rotate

| Trigger | Priority | Procedure |
|---|---|---|
| Routine (annual) | Planned | §1 Routine rotation |
| Key material leaked via git / logs | Emergency | §2 Emergency rotation |
| Personnel with access departs | Planned (within 30 days) | §1 Routine rotation |
| Post-security-incident | Emergency | §2 Emergency rotation |

## 1. Routine rotation

Plan for ~2 hours including re-encryption. Production re-encryption should
be performed during a scheduled maintenance window.

### 1.1 Generate the new key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Store the output in the secrets manager as the new value for
`PHI_ENCRYPTION_KEY`. Keep the current value under
`PHI_ENCRYPTION_KEY_PREVIOUS` until re-encryption is complete.

### 1.2 Pre-flight checks

- Back up the primary database. `pg_dump -Fc` is enough because every PHI
  column is text ciphertext — the backup itself is already encrypted.
- Confirm `PHI_HMAC_KEY` is set as a distinct key. If the codebase ever
  falls back to `PHI_ENCRYPTION_KEY` for HMAC, rotating the encryption
  key will break MRN lookups. Production startup refuses to launch if
  `PHI_HMAC_KEY` is unset.
- Run `pnpm --filter @carebridge/db-schema test` to confirm the
  encryption module still round-trips.

### 1.3 Deploy with both keys

Set the environment in this order on every replica:

```bash
PHI_ENCRYPTION_KEY_PREVIOUS=<current key>
PHI_ENCRYPTION_KEY=<new key>
```

Roll the fleet. After the rollout, every write uses the new key; reads of
existing rows fall back to the previous key. The application is correct
at this point — §1.4 only migrates historical rows to the new key so the
fallback can eventually be removed.

### 1.4 Re-encrypt historical rows

Before running the script, ensure `DATABASE_URL` is set in your shell.
`re-encrypt-phi.ts` exits immediately with `DATABASE_URL is not set` if
it is missing. Use the same production connection string you would use
for other maintenance tasks, including any required SSL parameters.

```bash
export DATABASE_URL='<postgres connection string>'
# Example if your environment requires SSL:
# export DATABASE_URL='postgres://user:pass@host:5432/dbname?sslmode=require'
```

Run the re-encryption script:

```bash
pnpm --filter @carebridge/scripts tsx src/re-encrypt-phi.ts --dry-run
pnpm --filter @carebridge/scripts tsx src/re-encrypt-phi.ts
```

The script iterates every table with encrypted columns, reads the stored
ciphertext directly, explicitly calls the same fallback-aware decryption
logic used during rotation (`decryptWithFallback`), and rewrites the row
so it persists under the new key. It bypasses the Drizzle custom type
intentionally: this is a bulk migration script, so it handles decryption
and re-encryption itself while still allowing rows encrypted with either
the current or previous key to be processed. Pagination is keyset
(`WHERE id > $lastId`) so runtime stays linear on large tables. It prints
per-table progress and a final summary.

For large datasets, the script supports `--batch-size=N` (default 500) and
`--table=<name>` to scope to one table at a time. Re-encrypting is
idempotent — re-running is safe.

### 1.5 Remove the previous key

After `re-encrypt-phi.ts` reports zero rows on a second dry-run pass,
unset `PHI_ENCRYPTION_KEY_PREVIOUS` on every replica and redeploy. Any
remaining row encrypted under the previous key will fail to decrypt after
this step — which is why §1.4 must succeed first.

### 1.6 Destroy the previous key

Remove the old value from the secrets manager's audit trail per your
organization's key-destruction policy. Record the destruction date in the
security-compliance log.

## 2. Emergency rotation (suspected compromise)

Assume the current key is exposed. Priority is cutting off the attacker's
ability to decrypt newly captured ciphertext, not preserving read
availability. Expect downtime.

### 2.1 Put the application in read-only or maintenance mode

Drop writes while the rotation completes. A gateway-level feature flag is
sufficient; halting write endpoints is preferred over a full outage.

### 2.2 Deploy with both keys (same as §1.3)

The compromised key goes into `PHI_ENCRYPTION_KEY_PREVIOUS`, the new key
into `PHI_ENCRYPTION_KEY`.

### 2.3 Re-encrypt aggressively

Run the re-encryption script with the default (no scope) to move every
row to the new key within the maintenance window.

### 2.4 Remove the previous key (same as §1.5)

Do NOT delay this step. Leaving `PHI_ENCRYPTION_KEY_PREVIOUS` set means a
compromise of the secrets manager now exposes both keys; emergency
rotation's whole point is that the compromised value stops being
load-bearing.

### 2.5 Rotate the rotation witnesses

After §2.4, rotate every credential that was in an env file alongside the
compromised `PHI_ENCRYPTION_KEY`:

- `JWT_SECRET`
- `SESSION_SECRET`
- `REDIS_PASSWORD`
- `PHI_HMAC_KEY` (requires its own migration — see §3)

### 2.6 File the incident report

Security policy requires a HIPAA breach-risk assessment within 72 hours.

## 3. HMAC key (`PHI_HMAC_KEY`) rotation

Not covered here. The MRN index column `mrn_hmac` stores deterministic
digests; rotating the HMAC key invalidates every indexed lookup. Rotation
requires:

1. A new `mrn_hmac_new` column backfilled under the new HMAC key
2. Dual-read support in the MRN lookup path
3. A cutover migration that drops the old column

Treat this as a separate project. Open a dedicated issue; do not combine
with a `PHI_ENCRYPTION_KEY` rotation.

## 4. Future work: managed KMS

The current design stores `PHI_ENCRYPTION_KEY` and
`PHI_ENCRYPTION_KEY_PREVIOUS` as plaintext environment variables. This is
acceptable for MVP but not for long-term production. The durable solution
is envelope encryption against a managed KMS (AWS KMS, HashiCorp Vault,
or GCP Cloud KMS):

- A Data Encryption Key (DEK) per row (or per tenant) is wrapped by a Key
  Encryption Key (KEK) held in the KMS. The ciphertext DEK is stored
  alongside the row; the KEK never leaves the KMS.
- Rotation of the KEK does not require re-encrypting every row — only the
  ciphertext DEKs must be re-wrapped, which the KMS can do in-place.
- Audit logging and access control move into the KMS, reducing the blast
  radius of an application-layer compromise.

Tracking issue: #291 (this issue remains open as the tracking anchor for
the KMS migration once the runbook + re-encrypt script land).

## 5. Sanity checks after any rotation

Run these before declaring rotation complete:

```bash
# Round-trip a known-PHI test write (or use the smoke test harness)
pnpm --filter @carebridge/db-schema test

# Application health
curl -fsS https://<env>/health

# Sample PHI read from a known-seeded patient
pnpm --filter @carebridge/api-gateway tsx scripts/smoke-phi-read.ts
```

If any check fails, do NOT remove `PHI_ENCRYPTION_KEY_PREVIOUS` — it is
the recovery path. Roll back the deploy, restore the previous values, and
re-assess.
