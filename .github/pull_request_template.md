<!--
PR template. Delete sections that don't apply rather than leaving them empty.
-->

## Summary

<!-- 1-3 sentences: what changed and why. -->

## Linked issues

<!-- e.g. "Closes #1234" — use "Closes" (not "Refs") so GitHub auto-closes the issue on merge. -->

## Test plan

- [ ]
- [ ]

## Database migrations

- [ ] N/A — this PR adds no migrations
- [ ] If this migration adds a CHECK / FK / NOT NULL on a populated column, used Pattern B (NOT VALID + VALIDATE) or Pattern A (pre-clean + add). See docs/migration-patterns.md.

## HIPAA / PHI

- [ ] No PHI in logs, error messages, or test fixtures
- [ ] Audit log writes added for any new PHI read/write paths
