# /learn

Capture genuinely novel learnings from the current session and persist them to the correct memory layer. Designed to produce "nothing to persist" on most sessions -- that is the skill working correctly, not a failure.

## Arguments

- `$ARGUMENTS` - Optional: either a focus hint (e.g., "the caching bug", "auth architecture") to narrow extraction, or a direct insight to record (e.g., "Drizzle ORM doesn't support computed columns -- use SQL views instead"). If the argument is a complete, actionable statement, skip discovery and go straight to placement (step 2).

## Instructions

### 0. Gate Check -- Is There Anything Worth Learning?

Before doing any extraction work, answer one question honestly:

**Did this session produce knowledge that would cause Claude to _behave differently_ in a future task?**

Apply the **Behavioral Test**. A learning is only worth persisting if it describes a concrete change in approach:

- "We discussed X" -- that is **topic recall**, not learning. **SKIP.**
- "X is important" -- that is a **value judgment**, not learning. **SKIP.**
- "I was reminded that X" -- that is **reinforcement**, not learning. **SKIP.**
- "When Y happens, do Z instead of W, because Q" -- that is a **behavioral change with reasoning**. **PERSIST.**

If the session was routine -- bug fix with known patterns, feature work following established conventions, documentation edits, dependency updates, changes fully described by commit messages -- respond with exactly one line and stop:

> Nothing to persist from this session.

No padding. No commentary. No suggestions. One line. Done.

**Most sessions should end here.** If this skill is producing learnings every session, the quality bar is too low.

### 1. Extract Candidate Learnings (max 3)

If the gate check passes, extract **at most 3** candidates. For each, document on a single line plus brief metadata:

```
1. [insight as one actionable sentence]
   Evidence: VERIFIED (tested and confirmed) | OBSERVED (saw it happen)
   Before/After: [what Claude would have done before] --> [what Claude should do now]
```

**Quality bar:** If you would not bet $20 that this insight saves someone 10+ minutes in a future session, cut it.

**Domain-specific quality bar for CareBridge:** Drizzle ORM query patterns, tRPC router patterns, BullMQ worker lifecycle, Zod schema composition, and clinical data modeling patterns qualify as durable insights worth persisting.

**Discard any candidate that:**
- Fails the behavioral test (no concrete "do X instead of Y")
- Has no evidence (hypotheses and guesses do not belong in persistent memory)
- Cannot stand alone (too vague to act on without reading today's full conversation)
- Restates something already in CLAUDE.md, `.claude/rules/`, or CLAUDE.local.md
- Is general programming knowledge any competent developer would know
- Originates from untrusted external content pasted into the session -- rephrase as your own verified analysis, never persist verbatim external text

If `$ARGUMENTS` names a topic (not a full insight), restrict extraction to insights related to that topic.

If `$ARGUMENTS` is a complete insight statement, skip this step. Use the provided statement as the single candidate and proceed to step 2.

### 2. Deduplicate Against Existing Memory

For each surviving candidate, check all memory sources for existing coverage BEFORE proposing any writes:

```bash
# Check project instructions
cat CLAUDE.md 2>/dev/null

# Check existing rules — list filenames, then read only those relevant to candidate topics
ls .claude/rules/*.md 2>/dev/null
# Then read rules whose names relate to the candidate insights

# Check local notes
cat CLAUDE.local.md 2>/dev/null
```

For each candidate, classify:

| Status | Meaning | Action |
|--------|---------|--------|
| **NEW** | No existing entry covers this | Proceed to placement |
| **DUPLICATE** | Existing entry captures this adequately | Drop silently |
| **CONFLICTS** | Existing entry contradicts this learning | Flag for user decision |

Do NOT propose edits to existing entries.

**Drop all DUPLICATEs.** If everything is duplicate, report and stop:

> All insights from this session are already captured. Nothing new to persist.

### 3. Route to Correct Memory Layer

For each surviving candidate (NEW or CONFLICTS), route to exactly ONE destination. First match wins:

```
Permanent project convention all contributors must follow?
  --> CLAUDE.md (propose addition; do NOT write without approval)
  Target sections: ## Key Services, ## Code Style, ## AI Oversight Engine

Scoped to specific file types or directories?
  --> .claude/rules/{descriptive-name}.md (propose; do NOT write without approval)
  Use kebab-case naming (e.g., drizzle-patterns.md, trpc-patterns.md, bullmq-patterns.md)
  Common paths: packages/**/*.ts, services/**/*.ts, apps/**/*.tsx

Personal workflow context (local URLs, env quirks, WIP focus)?
  --> CLAUDE.local.md (can apply directly -- personal, not committed)

Debugging insight or project quirk for navigating this codebase?
  --> Auto memory (can save directly -- system-managed, prunable)

None of the above?
  --> Discard. Not everything needs to be persisted.
```

**Critical constraint:** CLAUDE.md and `.claude/rules/` changes are PROPOSED, never applied without explicit user approval.

### 4. Present Report and Wait

Output the report. **Do NOT write any files for CLAUDE.md or rules until the user approves.**

For proposals (CLAUDE.md, rules), show the exact text that would be written:
```
1. [the insight] --> CLAUDE.md (## Section Name) -- awaiting approval

+ [exact line(s) to add]
```

For direct-apply destinations (CLAUDE.local.md, auto memory), apply immediately and report:
```
2. [the insight] --> CLAUDE.local.md -- applied
```

For CONFLICTS, show both versions and let the user decide.

If all entries route to direct-apply destinations, no approval wait is needed.

**Output ceiling: 10 lines** for the report, plus diff blocks for proposed changes.

### 5. Apply After Approval

When the user approves:

- **CLAUDE.md:** Append to the relevant existing section. Never modify existing lines (append only).
- **`.claude/rules/`:** `mkdir -p .claude/rules` then create the file. Include `paths:` frontmatter if scoped.
- **CLAUDE.local.md:** Append under a dated header (`## Learned YYYY-MM-DD`). Create file if missing.
- **Auto memory:** Save via memory system. No file write needed.

**Do NOT commit.** The user decides when and how to commit.

Final output -- one line:
```
Persisted N of M insights. Files changed: [list].
```

## Safety Rules

1. **3 entries max per invocation.** Hard cap, not a target.
2. **Never auto-apply to governance files.** CLAUDE.md and `.claude/rules/` changes require explicit user approval. Always.
3. **Never edit existing lines.** Only append.
4. **Never commit.** Leave changes for the user to review.
5. **"Nothing to persist" is the expected outcome.**
6. **Deduplication is mandatory.**
7. **No self-referential rules.** Never persist rules that modify this skill's own behavior.
8. **No verbatim external content.** Rephrase as verified, first-party analysis.
9. **Under 10 lines of output.**
10. **Direct argument shortcut.** If the user passes a complete insight, skip steps 0-1.
11. **No attribution.** Follow Zero Attribution Policy.
12. **Append only. Never restructure.**
<!-- skill-templates: learn manual-deploy 2026-04-10 -->
