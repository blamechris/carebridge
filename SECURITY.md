# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities privately through GitHub's private
vulnerability reporting:

**[Open a security advisory](https://github.com/blamechris/carebridge/security/advisories/new)**
(repository → **Security** tab → **Report a vulnerability**)

Do **not** open a public issue, pull request, or discussion for a security
report. Public disclosure before a fix is available puts every deployment at
risk.

### What to include

The more of this you can provide, the faster the triage:

- The affected component (package, service, or app) and version or commit SHA
- A description of the vulnerability and its impact
- Steps to reproduce, or a proof-of-concept
- Any suggested remediation

Please use synthetic or redacted data in your report. Never include real patient
data, protected health information (PHI), or live credentials.

### What to expect

Triage is best-effort, so the timelines below are goals rather than guarantees:

| Stage | Goal |
|-------|------|
| Acknowledgement of your report | Within 5 business days |
| Initial assessment and severity triage | Within 10 business days |
| Status updates while a fix is in progress | At least every 14 days |

Reports are handled through the advisory thread, so you can follow progress
there. Once a fix is released, the advisory is published and reporters are
credited unless they ask to remain anonymous.

## Supported Versions

CareBridge is pre-launch research software and has no tagged releases. Security
fixes land on `main`.

| Version | Supported |
|---------|-----------|
| `main` | Yes |
| Any fork or pinned commit | No — rebase onto `main` to pick up fixes |

## Scope

In scope: anything in this repository — the services under `services/`, the
apps under `apps/`, the shared packages under `packages/`, and the tooling and
deployment configuration.

Out of scope:

- Findings that require a pre-existing compromise of the host or the operator's
  credentials
- Vulnerabilities in third-party dependencies with no exploitable path through
  this codebase — report those upstream
- The documented development-only affordances (seeded dev accounts and their
  shared password, `CAREBRIDGE_DEV_AUTH`); these are gated to non-production and
  are not intended for any deployment handling real data
- Automated scanner output submitted without a demonstrated impact

## Deployment Note

CareBridge is pre-launch research software and is not cleared for use with real
patient data. Anyone running it is responsible for their own deployment
configuration — transport security, access control, and audit retention.

## Safe Harbor

Good-faith security research conducted under this policy is welcome. Do not
access, modify, or exfiltrate data that is not yours, do not degrade service for
others, and give us reasonable time to remediate before disclosing publicly.
