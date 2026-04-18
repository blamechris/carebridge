# HIPAA Audit Log Retention Policy

## Retention Period

CareBridge retains audit log records for **7 years** from the date of the
recorded event. This exceeds the HIPAA Security Rule minimum of 6 years
(45 CFR 164.316(b)(2)(i)) by one year as a safety buffer to absorb
off-by-one errors, archival lag, and jurisdictional variance (some state
laws require longer retention).

## Immutability

The `audit_log` table is append-only. PostgreSQL triggers
(`audit_log_no_update`, `audit_log_no_delete`, migration
`0012_audit_log_immutability.sql`) raise an exception on any UPDATE or
DELETE against the table. This provides database-level tamper protection
independent of application code.

### Scope of immutability guarantees

| Table | Role | Immutability triggers | Notes |
|---|---|---|---|
| `audit_log` | Authoritative tamper-evident audit trail | Yes (migration 0012) | Append-only; UPDATE/DELETE blocked at DB level |
| `review_jobs` | Supplementary operational state | No | Stores `rules_output` for decision reconstruction (migration 0032); mutable by normal application operations |

Only `audit_log` satisfies the HIPAA tamper-evidence requirement
(§164.312(b)). `review_jobs.rules_output` is retained for operational
decision reconstruction but is **not** covered by immutability triggers
and should not be cited as part of the tamper-evident audit trail.

## review_jobs Retention and PHI Handling

The `review_jobs` table — including its `rules_output`, `redacted_prompt`,
and `redaction_audit` columns — is subject to the same **7-year retention
policy** as `audit_log`. These records support forensic decision
reconstruction (which rules fired, what context was available, what was
redacted before LLM submission) and must be preserved for the full
retention window.

### PHI-adjacent data in rules_output

`rules_output` stores serialized `RuleFlag` records produced by the
deterministic rules engine. These records may contain **PHI-adjacent
details** including:

- Matched drug names and allergy substrates
- Severity reasoning tied to a specific patient encounter
- Condition and diagnosis context used in cross-specialty pattern matching

This data is **not encrypted at the column level** (unlike
`patient_diagnosis_notes`, which uses column-level encryption per
migration 0028). It is also **not covered by append-only immutability
triggers** — see the scope-of-immutability table above. Access to
`review_jobs` rows must therefore be controlled through application-level
authorization, database role restrictions, and audit logging of any
direct queries against the table.

### Relationship to other review_jobs columns

| Column | Contents | Encrypted | Immutable |
|---|---|---|---|
| `redacted_prompt` | Sanitized prompt sent to LLM | No | No |
| `redaction_audit` | Record of what was redacted | No | No |
| `rules_output` | Serialized RuleFlag results | No | No |

All three columns share the same retention, access-control, and
archival treatment described in this document.

## Archival Plan (future work)

To keep the hot `audit_log` table fast while preserving long-term
retention, logs will be archived on the following schedule:

1. Records newer than 1 year live in the primary `audit_log` table.
2. Records between 1 and 7 years old are moved nightly to cold storage
   (e.g. an archival partition or object-storage export). The archive
   inherits the same immutability guarantees.
3. Records older than 7 years are eligible for deletion **only** after
   the legal hold release process below.

The archival job is not yet implemented. Until it ships, all audit log
records remain in the primary table.

## Deletion / Legal Hold Release

Audit log records may only be deleted after a documented legal hold
release process:

1. Written request from the Privacy Officer or General Counsel
   identifying the records and justification.
2. Confirmation that no active legal hold, litigation, investigation,
   audit, or regulatory inquiry covers the records.
3. Approval recorded in the compliance tracking system.
4. Deletion performed by a DBA with the trigger temporarily disabled
   inside a transaction, then re-enabled. The deletion itself is logged
   to a separate compliance audit trail.

Routine operational deletion of audit log records is prohibited.
