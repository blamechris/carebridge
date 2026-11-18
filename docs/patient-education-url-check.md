# Patient-education URL check

The checker measures HTTP reachability for the public resources linked from
CareBridge's curated patient-education tables. A passing response establishes
reachability for that probe. Clinical suitability, accuracy, and relevance
require a separate content review.

## Run locally

With the workspace dependencies installed, run from the repository root.

```bash
pnpm --filter @carebridge/medical-logic run check:education-urls
```

The script sends live HTTP requests to the curated URLs and prints totals
and a failure table to the terminal. It exits `1` if any URL fails. The probe
uses static source tables and needs no running CareBridge services, real
patient records, or provider credentials. GitHub issue writes happen in the
Actions workflow. [Package script](../packages/medical-logic/package.json) ·
[Checker](../packages/medical-logic/scripts/check-education-urls.ts)

## Interpret the report

The checker extracts URLs from both the diagnosis and medication education
tables, deduplicates and sorts them, then probes them sequentially. Each URL
starts with `HEAD`. The checker follows redirects and uses the final response
status. A `405` from `HEAD` is the sole trigger for a `GET` retry. Each attempt
has its own 10-second timeout. [Education tables](../packages/medical-logic/src/patient-education.ts)

| Result | Meaning for the check |
| --- | --- |
| `2xx` | The request passed. |
| `403` | The request was denied and failed the check. |
| `404` | The request returned “not found” and failed the check. |
| No HTTP status | The request timed out or failed before a response. Read the reported reason. |
| Other final HTTP status | The request failed the check. A `405` from the `GET` retry also fails. |

## Scheduled and manual runs

In GitHub Actions, open **Patient Education URL Check** to see scheduled runs
or use **Run workflow** for a manual run. The workflow is scheduled for 09:00
UTC on the first of each month and runs separately from push and pull-request
CI. [URL-check workflow](../.github/workflows/patient-education-url-check.yml) ·
[CI workflow](../.github/workflows/ci.yml)

The workflow installs dependencies with `pnpm install --frozen-lockfile`.
The check step captures the script's output and exit status and lets the
workflow continue. The script writes its report to the Actions step summary
when `GITHUB_STEP_SUMMARY` is set. If the captured exit status is nonzero, the
workflow uses its GitHub token to comment on a matching open tracking issue
or to create a new one. It also attempts to create the `url-rot` label if needed.
The issue write includes the run link and checker log.
A final step then marks the job as failed. A successful run leaves tracking
issues open for maintainers to review. For a manual probe without GitHub issue
writes, use the local command.

## Triage a failure

1. Open the run summary and find the row for the URL. If there is no report,
   inspect the step logs to see whether the checker ran.
2. Record the URL, checked commit SHA, run link or local execution, UTC time,
   request method, final HTTP status or absence of one, and reported reason.
   Keep observations from different runs tied to their respective commits.
3. For a `404`, compare the checked URL with the current curated entry and
   verify the publisher's URL before proposing a correction. For a `403`,
   record the denial. If you check in a browser, record what the browser
   displayed and when as a separate observation. A `403` alone cannot establish
   that the page was removed or that the publisher blocks automated requests.
4. Keep content-review notes separate from probe and browser results. Record
   whether the page still matches the intended diagnosis or medication topic
   and which suitability questions need review. Consolidate the evidence in
   the tracking issue the workflow opened or updated for that run. For a local
   probe, use the matching current tracking issue; the issue below belongs to
   the historical snapshot.

## Historical snapshot

The scheduled run on 2026-11-01 at commit
`84e3a804c6d10f79ccde4448e5c86e71815b103b` checked 31 URLs. Of those, 22
passed and 9 failed. Four CDC URLs returned `404`, and five URLs on
`heart.org` or `stroke.org` returned `403`.
[2026-11-01 Actions run](https://github.com/blamechris/carebridge/actions/runs/41291832924)

PR #1344 subsequently updated the four CDC paths in merge commit `1719cff`.
The counts above describe the November 1 run on its original commit. The
snapshot establishes no post-repair full-list result. The tracking issue remains
open. [Merged PR #1344](https://github.com/blamechris/carebridge/pull/1344) ·
[Tracking issue #1324](https://github.com/blamechris/carebridge/issues/1324)
