# Contributing to CareBridge

CareBridge is pre-launch research software, not for clinical use. Read the
[README research warning](README.md) before contributing. Use wholly synthetic
data in issues, pull requests, fixtures, and examples. Never submit real patient
records or PHI, screenshots or recordings of real people, personal contact data,
credentials, or access links. Do not paste unreviewed logs or attach real records.

For vulnerabilities, follow [SECURITY.md](SECURITY.md) and its
[private reporting link](https://github.com/blamechris/carebridge/security/advisories/new).
Do not report security problems through public issues, pull requests, or discussions.

## Choose a focused change

Check existing issues and pull requests for overlapping work. Use the bug-report
or feature-request form for a software problem or proposal, with fabricated
examples and observable acceptance criteria. Keep the change focused on the
agreed scope; discuss substantial architecture or behavior changes before building
them. A feature request does not authorize real-data use or deployment.

For local setup, follow [Quick Start](README.md#quick-start). Existing development
commands, build order, and migration instructions remain in the
[Development Workflow](README.md#development-workflow).

## Branch and pull request workflow

1. Start a focused feature branch from up-to-date `main`; do not work directly on
   `main`. Existing repository prefixes include `feat/`, `fix/`, `refactor/`,
   `chore/`, and `docs/`. Use a descriptive name, such as
   `docs/1332-contribution-guidance`.
2. Inspect analogous code and shared packages before adding another implementation.
   Keep unrelated changes out of the pull request.
3. Follow the code and commit conventions below, and validate the affected scope.
4. Open a pull request targeting `main` using the
   [existing PR template](.github/pull_request_template.md). Explain the problem,
   resulting behavior, and validation. Include `Closes #N` in the body only when
   the change actually addresses that issue. Remove inapplicable template sections
   rather than leaving them empty; retain applicable migration and PHI checks.
5. Complete the required review and checks below. Report pending or unavailable
   validation explicitly and keep the PR draft while required gates remain pending.
6. Leave the reviewed PR open for human review and merge. This repository withholds
   unattended merge authority: automation must not merge, enable auto-merge, or
   bypass branch protections, even when review and CI are clean.

## Code conventions

- **TypeScript strict mode** everywhere.
- **ESM** — `type: "module"` in `package.json`, with `.js` extensions in imports.
- **Functional style** — prefer functions over classes.
- **Dates** — ISO 8601 strings (`new Date().toISOString()`).
- **UUIDs** — `crypto.randomUUID()`, without an external UUID package.
- **Workspace packages** — import as `@carebridge/*`.

Follow the applicable service/package/app conventions in
[CLAUDE.md](CLAUDE.md) and the [repository skill profile](.claude/skill-profile.md),
including Zod validation at service boundaries, shared types and validators,
and clinical-event emission for clinical data mutations. Frontends do not access
the database directly; use the established tRPC paths through the API gateway.

## Commit format

```text
type(scope): short summary in present tense
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`.

Scopes: `db`, `ai`, `notes`, `clinical`, `auth`, `gateway`, `portal`, `infra`.

Examples:

```text
feat(portal): add a care-team summary view
fix(gateway): validate a request parameter
docs(infra): explain local setup
```

Use clean commit messages and PR descriptions without attribution footers or
co-author trailers, as required by [CLAUDE.md](CLAUDE.md).

## Validation and review

The required local check is:

```bash
pnpm typecheck && pnpm lint
```

Record the command and actual result in the PR test plan. Remote CI does not
replace this local gate. If the environment cannot run it, mark it **pending**;
do not report it as passed or waive it.

Choose additional validation that exercises the changed behavior:

- For code changes, add or update meaningful tests for the affected behavior and
  run the relevant workspace tests. `pnpm test` runs the workspace suite; focused
  workspace tests can shorten the feedback loop. Test an affected service locally
  when the change alters its behavior, and record any runtime checks performed.
- For UI changes, inspect the changed user flow and relevant loading, error, and
  empty states with synthetic data. Passing compilation alone does not establish
  that the flow works.
- For pure documentation/configuration changes, application tests may be **N/A**
  with an explanation. Check links and Markdown, and parse/validate changed
  configuration such as issue-form YAML. These checks do not waive typecheck/lint.
- For migrations and clinical-review prompt changes, follow the existing
  [migration guidance](docs/migration-patterns.md) and
  [prompt-editing guidance](docs/ai-prompt-editing.md), respectively.

Before merge, complete `/full-review` according to the
[repository skill profile](.claude/skill-profile.md) and
[review workflow](.claude/commands/full-review.md), address review feedback, and
verify CI on the final commit. Use those linked policy files as the authority;
this guide creates no new review exceptions. Never claim a review or check passed
without its evidence. Completing the gates leaves the PR ready for a human to
merge; it does not grant automation merge authority.
