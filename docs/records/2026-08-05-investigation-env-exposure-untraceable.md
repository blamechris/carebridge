---
type: investigation
date: 2026-08-05
status: active
scope: [.env handling, secret management, git history]
issue: carebridge#135
evidence: VERIFIED
supersedes: null
sensitivity: security
---

# The 2026-04 `.env` exposure is untraceable; risk accepted, secrets not rotated

## Trigger

CLAUDE.md carried a SECURITY NOTICE (added by `0a1dbe1`, closing #135) stating
`.env` "was previously tracked in git history" with `PHI_ENCRYPTION_KEY`,
`JWT_SECRET`, `REDIS_PASSWORD`, `SESSION_SECRET`, and that all four MUST be
rotated. Before performing that rotation, a four-agent forensic investigation
re-verified the premise.

## What the sweep covered

- All 1,426 commits reachable from every local branch, remote-tracking branch,
  and tag; all 22 stash entries including untracked-file parents; every
  fsck-reported dangling/unreachable commit, tree, and blob.
- A per-commit `git cat-file -e <sha>:.env` tree test (defeats blob-dedup blind
  spots in `rev-list --objects`); also tested `.env.local`, `.env.production`,
  `.env.dev`, and per-service `.env` paths.
- Pickaxe + entropy scan across all refs for real-shaped secrets (including
  `sk-ant-` prefixed keys).
- GitHub-side surfaces: Actions / Dependabot / Codespaces / environment secret
  stores (names only), workflow files, deploy configs, DNS for the
  once-planned `bridge.carebridge.health` host.

## Findings

1. **No commit in any retrievable history ever contained a tracked `.env`.**
   The commit closing #135 was documentation-only (its own message says `.env`
   was already untracked); companion PR #162 was closed unmerged.
2. An unmerged branch's rotation runbook cites a removal commit `bd1f…` that
   does not exist in this clone — the `.env`-bearing history, if it was ever
   pushed, was rewritten away before the present clone state.
3. **No real-shaped secret ever entered retrievable history.** Every historical
   `.env.example` revision holds placeholders or empty values; the only
   Anthropic key shape ever committed is a 10-char `sk-ant-` stub.
4. Three of the four named secrets are dev placeholders in the local untracked
   `.env`; the two genuinely random keys (`PHI_ENCRYPTION_KEY`, `PHI_HMAC_KEY`)
   exist only locally and encrypt synthetic seed data.
5. Nothing to rotate anywhere else: all GitHub secret stores are empty, no
   deploy configs exist, and `bridge.carebridge.health` no longer resolves.

## Decision

**Risk accepted; secrets not rotated** (owner decision, 2026-08-05). Residual
risk is limited to a hypothetical GitHub server-side unreachable object whose
existence no local evidence supports.

**Revisit triggers — rotate (see `docs/phi-key-rotation.md`) if any becomes true:**

1. CareBridge moves toward production use or any non-synthetic PHI.
2. Evidence surfaces that a real `.env` was ever pushed.
3. Any of these values is reused outside the local dev environment.

Known rotation-tooling defects are tracked in #1334 (broken
`pnpm --filter … tsx` invocation in the docs, no `.env` auto-loading,
`turbo.json` passthrough gaps for `REFRESH_TOKEN_HMAC_KEY` /
`PHI_ENCRYPTION_KEY_PREVIOUS`).

## What a future agent should NOT redo

- Do not re-run git-history archaeology for `.env` — it was done exhaustively
  (all refs, stashes, dangling objects, per-commit tree tests) on 2026-08-05.
- Do not treat the phantom `bd1f…` SHA (cited on branch
  `claude/plan-clinical-ai-system-YAqmG`) as a real commit to find.
- Do not open a new rotation effort absent a revisit trigger above; the
  full verified runbook is preserved (owner's vault,
  `carebridge-secret-rotation-2026-08-05.html`) and #135's final comment
  carries the complete investigation record.
