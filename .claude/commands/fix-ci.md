# /fix-ci

Diagnose CI failures or cancellations on a PR, take corrective action (re-trigger, fix, or escalate), and report status.

## Arguments

- `$ARGUMENTS` - PR number (optional, defaults to current branch's PR)

## Instructions

### 0. Gather CI State

```bash
PR_NUM=${1:-$(gh pr view --json number -q .number)}
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
BRANCH=$(gh pr view ${PR_NUM} --json headRefName -q .headRefName)
HEAD_SHA=$(gh pr view ${PR_NUM} --json headRefOid -q .headRefOid)

echo "PR: #${PR_NUM} | Branch: ${BRANCH} | HEAD: ${HEAD_SHA}"

# Get the latest CI run(s) for this branch
gh run list --branch ${BRANCH} --limit 5 --json databaseId,status,conclusion,headSha,event,createdAt
```

### 1. Get Job-Level Status

For the most recent run matching `HEAD_SHA`:

```bash
RUN_ID=<id from step 0>
gh run view ${RUN_ID} --json jobs --jq '.jobs[] | {name, status, conclusion}'
```

Count jobs by status: passed, failed, cancelled, skipped, in_progress.

### 2. Classify Overall State

Apply these rules **in order** (first match wins):

| Classification | Condition | Action |
|----------------|-----------|--------|
| **ALL_PASS** | Latest run's SHA matches HEAD AND all required jobs passed | Report green, exit |
| **IN_PROGRESS** | Any job still running or queued | Poll until complete (see Step 2a) |
| **STALE** | Latest run's SHA does NOT match HEAD | Check for newer run, or retrigger |
| **CANCELLED** | One or more jobs cancelled, none failed | Check for replacement run (see Step 2b) |
| **FAILED** | One or more jobs failed | Per-job diagnosis (Step 3) |

#### 2a. IN_PROGRESS — Poll for Completion

```bash
MAX_WAIT=300  # seconds
INTERVAL=30
ELAPSED=0

while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(gh run view ${RUN_ID} --json status -q .status)
  [ "$STATUS" = "completed" ] && break
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
  echo "Waiting for CI... ${ELAPSED}s / ${MAX_WAIT}s"
done
```

#### 2b. CANCELLED — Check for Replacement Run

```bash
gh run list --branch ${BRANCH} --limit 5 --json databaseId,status,conclusion,headSha,event \
  | jq --arg sha "$HEAD_SHA" '[.[] | select(.headSha == $sha)]'
```

### 3. Per-Job Diagnosis (for FAILED or CANCELLED jobs)

```bash
# For failed jobs — get the failure logs
gh run view ${RUN_ID} --log-failed 2>&1 | tail -100

# For cancelled jobs
gh api repos/${REPO}/actions/runs/${RUN_ID}/jobs --jq '.jobs[] | select(.conclusion != "success" and .conclusion != "skipped") | {name, conclusion, steps: [.steps[] | select(.conclusion != "success" and .conclusion != "skipped") | {name, conclusion}]}'
```

**Known failure patterns for CareBridge:**
- TypeScript strict mode violations — FIX
- Missing `.js` extensions in ESM imports — FIX
- Drizzle schema drift (migration out of sync) — FIX
- `pnpm typecheck` failures — FIX
- `pnpm lint` failures — FIX
- `pnpm build` failures — FIX

Generic patterns:
- `rate limit` / `API rate limit exceeded` → RETRIGGER (transient)
- `timeout` / `timed out` → RETRIGGER (transient)
- `connection refused` / `ECONNRESET` → RETRIGGER (transient)
- `permission denied` / `403` → ESCALATE (permissions issue)
- `out of disk space` → ESCALATE (infrastructure)
- `cancelled` (no failure) → RETRIGGER

### 4. Take Action

#### RETRIGGER

```bash
gh run rerun ${RUN_ID} --failed
```

**One retrigger attempt only.**

#### FIX

```bash
git checkout ${BRANCH}
# Make the fix
git add <files>
git commit -m "fix(ci): Description of fix"
git push
```

#### ESCALATE

Report diagnosis to the user with relevant log excerpt.

### 5. Wait for CI (if action taken)

```bash
MAX_WAIT=300
INTERVAL=30
ELAPSED=0
sleep 10
NEW_RUN_ID=$(gh run list --branch ${BRANCH} --limit 1 --json databaseId -q '.[0].databaseId')

while [ $ELAPSED -lt $MAX_WAIT ]; do
  STATUS=$(gh run view ${NEW_RUN_ID} --json status -q .status)
  [ "$STATUS" = "completed" ] && break
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

CONCLUSION=$(gh run view ${NEW_RUN_ID} --json conclusion -q .conclusion)
```

### 6. Summary Report

```markdown
| PR | CI Status | Jobs | Action Taken |
|----|-----------|------|--------------|
| #XX | PASS (after retrigger) | 6/6 passed | Retriggered: Run Tests cancelled by concurrency |
```

## Critical Rules

1. **Diagnose before acting** — Never blindly retrigger.
2. **One retrigger attempt** — If re-run fails, escalate.
3. **SHA awareness** — Always verify CI run matches HEAD.
4. **Log excerpts in escalations** — Include relevant log lines.
5. **Minimal fix scope** — Surgical fixes only.
6. **Composable** — Works standalone or from `/full-review`.
7. **Idempotent** — Safe to re-run.
8. **No attribution** — Follow Zero Attribution Policy.
<!-- skill-templates: fix-ci manual-deploy 2026-04-10 -->
