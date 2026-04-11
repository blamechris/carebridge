# /swarm-audit

Launch a swarm of specialized agents to perform a multi-perspective audit of any design document, architecture, codebase, or proposal.

## Arguments

- `$ARGUMENTS` - Path to the document or topic to audit, plus optional agent count (default: 6). Examples:
  - `docs/architecture/proposal.md`
  - `docs/rfc-001.md 8` (8 agents)
  - `"the authentication flow in src/auth.js" 4`

## Instructions

### 1. Parse Arguments

```
TARGET = first argument (file path or quoted topic description)
AGENT_COUNT = second argument (default: 6, min: 4, max: 10)
```

If TARGET is a file, read it. If TARGET is a topic/description, treat it as the audit subject and explore the relevant code.

### 2. Create Output Directory

Create a directory for audit results adjacent to the target:
- If target is a file: `<same-dir>/audit-results/`
- If target is a topic: `docs/audit-results/<slugified-topic>/`

### 3. Select Agent Panel

Choose AGENT_COUNT agents from this roster. Always include the first 4 (core panel). Add from the extended roster based on relevance to the target.

#### Core Panel (always included)

| Agent | Nickname | Lens | Personality |
|-------|----------|------|-------------|
| Skeptic | "Skeptic" | Claims vs reality, false assumptions, what won't work | Cynical systems engineer who has seen too many designs fail. Cross-references every claim against actual code. |
| Builder | "Builder" | Implementability, effort estimates, missing components, dependencies | Pragmatic full-stack dev who will implement this. Revises effort estimates, identifies file-by-file changes. |
| Guardian | "Guardian" | Safety, failure modes, race conditions, data integrity, recovery | Paranoid security/SRE who designs for 3am pages. Finds race conditions and nuclear scenarios. Guardian should weight type safety: are package boundary contracts enforced end-to-end? |
| Minimalist | "Minimalist" | YAGNI, complexity reduction, 80/20 cuts, simpler alternatives | Ruthless engineer who believes the best code is no code. Identifies what to cut and proposes minimal alternatives. |

#### Extended Roster (pick based on relevance)

| Agent | Nickname | Lens | When to Include |
|-------|----------|------|-----------------|
| Operator | "Operator" | UX walkthrough, daily experience, error states, accessibility. Operator should weight data integrity: are clinical events correctly emitted and consumed? | Target involves user-facing features, UI, or interaction flows |
| Futurist | "Futurist" | Extensibility, technical debt forecast, plugin architecture | Target involves architecture decisions with long-term implications |
| Domain Expert | "Expert" | Deep domain knowledge for the specific technology | Target involves specific tech. Name the agent after the domain. Expert agents should verify claims against Drizzle ORM and tRPC documentation |
| Adversary | "Adversary" | Attack surface, abuse cases, security boundaries | Target involves auth, networking, data handling, or external interfaces |
| Tester | "Tester" | Testability, edge cases, coverage gaps, test strategy | Target involves complex logic, state machines, or protocol design |
| Historian | "Historian" | Precedent, prior art, industry patterns, what others have done | Target involves novel architecture or unconventional approaches |
| Healthcare Data Architect | "Chart Keeper" | FHIR R4, ICD-10/CPT codes, clinical data modeling, EHR interoperability, HIPAA-adjacent patterns | Target involves patient data schema, clinical data structures, FHIR gateway, or data migration |
| AI Safety Inspector | "Oversight" | LLM prompt safety, hallucination risk in clinical contexts, prompt injection, Claude API response validation, deterministic rule coverage | Target involves ai-oversight service, clinical rules engine, prompts, or flag generation logic |

### 4. Launch Agent Swarm

Launch ALL agents in parallel using the Task tool. Each agent receives:

1. The full target document/topic description
2. Their specific persona, lens, and rating criteria
3. Instructions to explore the actual codebase (read relevant files, not just the doc)
4. A rating rubric: rate each section 1-5 with justification

**Agent prompt template:**

```
You are **"{NICKNAME}"** -- {PERSONALITY}

Your job is to audit the following from the lens of **{LENS}**.

## Target
{TARGET_CONTENT_OR_DESCRIPTION}

## Your Audit Must Cover
1. Section-by-section ratings (1-5) with justification
2. Top 5 findings in your area of expertise
3. Specific evidence from the codebase (file:line references)
4. Concrete recommendations (not vague suggestions)
5. Overall rating with summary

## Rules
- READ the actual codebase, not just the document. Verify claims against code.
- Be specific. "This might be a problem" is useless. "Line 42 of ws-server.js does X which contradicts the doc's claim of Y" is useful.
- Rate honestly. 3/5 means "adequate." 5/5 means "I cannot find meaningful fault." 1/5 means "fundamentally broken."
- End with a single overall rating and one-paragraph verdict.
```

**IMPORTANT**: Do NOT run agents in the background. Run them as foreground Task calls so their output returns directly. If running more than 4 agents, batch them: first 4 in parallel, then remaining agents in parallel.

### 5. Write Individual Reports

After all agents return, write each agent's findings to its own file:

```
audit-results/
  00-master-assessment.md    <- You write this (step 6)
  01-skeptic.md
  02-builder.md
  03-guardian.md
  04-minimalist.md
  05-{agent}.md              <- Additional agents
  ...
```

### 6. Write Master Assessment

Create `00-master-assessment.md` that synthesizes all agent findings.

#### Required Sections

**a. Auditor Panel Table**
**b. Consensus Findings** (4+ agents agree)
**c. Contested Points**
**d. Factual Corrections**
**e. Risk Heatmap**
**f. Recommended Action Plan**
**g. Final Verdict** (weighted average: core panel 1.0x, extended 0.8x)
**h. Appendix** (links to individual reports)

### 7. Commit Results

```bash
git add <audit-results-directory>/
git commit -m "docs: swarm audit of <target> (<N> agents)

Aggregate rating: X.X/5. Key findings: <top 3 consensus items>.
"
```

Do NOT push unless explicitly asked.

### 8. Report to User

- Aggregate rating
- Agent panel (names + individual ratings)
- Top 3 consensus findings
- Top contested point
- Recommended next action
- Path to full results

## Configuration

### Rating Scale

| Rating | Meaning |
|:------:|---------|
| 5/5 | Excellent. Cannot find meaningful fault. |
| 4/5 | Good. Minor issues that don't block implementation. |
| 3/5 | Adequate. Works but has gaps that need addressing. |
| 2/5 | Concerning. Significant issues that may cause failures. |
| 1/5 | Fundamentally broken. Needs rethinking, not patching. |

### Agent Behavior Rules

- Agents MUST read actual source code, not just the target document
- Agents MUST provide file:line references for claims
- Agents MUST rate each major section independently
- Agents MUST end with a concrete top-5 recommendations list
- Agents should be opinionated, not diplomatic. Strong views, loosely held.
<!-- skill-templates: swarm-audit manual-deploy 2026-04-10 -->
