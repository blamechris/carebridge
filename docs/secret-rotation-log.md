# Secret Rotation Log

Append-only record of every secret rotation event. New entries go at the
top. Never edit or delete historical entries — if a mistake is made,
append a correction entry referencing the original timestamp.

Format per entry:

```
## YYYY-MM-DD — <secret label(s)>

- Operator: <handle>
- Reason: scheduled | emergency | initial-remediation
- Environments: staging, prod, ...
- Approved by: <handle>
- Snapshot taken: yes (snapshot-id) | n/a
- Verification: <brief smoke-test result>
- Notes: <anything else>
```

See `docs/secret-rotation-runbook.md` for the full procedure.

---

<!--
No rotation events recorded yet. The first entry MUST be the initial
remediation rotation required by the historical .env leak documented in
CLAUDE.md. Do not ship Phase A/B/C code to any environment with real PHI
until that entry is present.
-->
