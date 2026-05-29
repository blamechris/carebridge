# Clinician Bridge — MVP Scope

## Purpose

The clinician bridge is the third leg of the safety stack. It lets a
family caregiver hand off a MedLens-captured patient record to a
clinician at the bedside so the clinician can see the cross-specialty
deterioration patterns CareBridge surfaces, without the clinician needing
an EHR account, a CareBridge account, or any persistent infrastructure.

> See `MISSION.md` for the founding story. The bridge exists because the
> primary failure mode CareBridge targets — care coordination across
> admissions and specialties — almost always shows up first in the
> caregiver's observations, not in the chart.

## Non-Goals

- **Not an EHR.** No write-back to Epic/Cerner. Read-only context.
- **Not a record of truth.** Bridge holds no PHI past the tab session.
- **Not a clinician account system.** Anonymous, single-session use.
- **Not a mobile app.** Browser-only. Works on any phone or tablet.
- **Not a diagnosis tool.** Surfaces patterns with citations; clinician
  decides.

## User Flow

1. Family caregiver opens MedLens on their phone (already has the
   captured timeline: meds, vitals, symptoms, observations).
2. Caregiver taps **"Share with clinician"** → MedLens generates a
   15-minute paired token + 6-character code + QR.
3. At the bedside, caregiver shows the QR to the clinician (or reads the
   code).
4. Clinician opens `bridge.carebridge.health` on their own device, scans
   QR or types the code.
5. Bridge fetches the MedLens capture using the paired token.
6. Bridge runs CareBridge `ai-oversight` rules against the capture.
7. Clinician sees a structured bedside summary:
   - **Cross-specialty patterns** (DETERIORATION-TRAJECTORY-001 +
     sub-rule hits, with citations).
   - **Timeline** of vitals/meds/symptoms across admissions.
   - **Open consult loops** and **discharge readiness** flags.
8. Clinician closes the tab → all PHI gone from the bridge device.

## Architecture

```
┌───────────────────────────────────────────────────────────────┐
│  MedLens (caregiver phone, local-first)                       │
│  - Holds the captured timeline locally                        │
│  - Issues paired tokens scoped to a single capture, 15 min    │
└────────────────────────┬──────────────────────────────────────┘
                         │ (token transport — see Open Q1)
                         ▼
┌───────────────────────────────────────────────────────────────┐
│  bridge.carebridge.health  (apps/clinician-bridge, Next.js)   │
│  - Vercel free tier                                           │
│  - No DB, no persistent PHI                                   │
│  - Memory-only: capture + flag results live in React state    │
└────────────────────────┬──────────────────────────────────────┘
                         │ tRPC (server action)
                         ▼
┌───────────────────────────────────────────────────────────────┐
│  api-gateway → ai-oversight                                   │
│  - Stateless rule run against the supplied capture            │
│  - Returns RuleFlag[] + citations                             │
│  - Writes to audit_log (HIPAA-retention 7y) — see Open Q3     │
└───────────────────────────────────────────────────────────────┘
```

## Tech Stack

- **Next.js 15 App Router** — matches existing apps in `apps/`.
- **Vercel free tier** — static + serverless functions; $0 hosting at
  expected MVP volume.
- **tRPC client** to `api-gateway` — reuses the existing rule path; no
  duplicate rule code in the bridge.
- **QR scan**: native `BarcodeDetector` where available, polyfill via
  `@yudiel/react-qr-scanner` for iOS Safari.
- **No DB, no auth, no users.** Bridge is a thin client.

## PHI / SaMD Posture

- **Bridge does not persist PHI.** All data is React state, cleared on
  tab close or refresh. Browser storage (`localStorage`,
  `IndexedDB`, service workers) is explicitly disabled.
- **Token from MedLens is patient-authorized share.** The caregiver
  actively chose to share; the bridge does not initiate the fetch.
- **Bridge falls under §520(o) non-device CDS** alongside CareBridge
  proper — see `docs/cds-exemption.md`. Same four criteria apply: every
  flag carries citations, the clinician is the decision-maker, the
  bridge surfaces rather than recommends.
- **Audit log** is the only place PHI-adjacent data persists. Rule
  firings, capture hash (not capture body), and clinician
  self-identification land in `audit_log` (append-only, 7-year
  retention per `docs/hipaa-retention.md`).

## Out-of-Repo Dependencies

- **MedLens** must expose two endpoints for the bridge to work:
  1. `POST /v1/pair` (caregiver-driven, returns a token + code + QR
     payload).
  2. `GET /v1/captures/:id?token=...` (token-scoped, returns the
     timeline JSON the bridge expects).
- These belong in the MedLens repo. File a tracking issue there once
  this doc lands.

## File Layout

```
apps/clinician-bridge/
├── package.json
├── next.config.ts                # disables service workers explicitly
├── app/
│   ├── page.tsx                  # landing: QR scanner + manual code
│   ├── session/[code]/page.tsx   # post-pair: fetch + render
│   └── api/
│       └── flag/route.ts         # server action → api-gateway tRPC
├── components/
│   ├── PairingScanner.tsx
│   ├── TimelineView.tsx
│   ├── FlagCard.tsx              # severity-styled flag with citations
│   └── PostMortemBanner.tsx      # "not a diagnosis" disclaimer
└── lib/
    ├── medlens-client.ts         # paired-token capture fetch
    └── rule-client.ts            # tRPC client to api-gateway
```

## Open Questions

**Q1 — Token transport.** Three options for how the bridge fetches the
capture from MedLens:

| Option | Where capture lives | Bridge fetches from | Notes |
|---|---|---|---|
| **(a) Relay** | Caregiver phone uploads encrypted blob to CareBridge edge cache when share-button pressed; cache expires in 15 min | CareBridge edge cache | Simplest UX, requires us to run a relay (still $0 on Cloudflare R2 / Vercel KV with TTL). |
| **(b) Local net** | Capture stays on caregiver phone; phone runs a tiny HTTP server | Caregiver phone over local WiFi | No infra, but flaky on hospital networks. |
| **(c) QR-embedded** | Capture serialized into a multi-frame QR | Camera scan | Works offline, but limited to ~3 KB per frame; only viable for small captures. |

Recommend (a) for MVP; revisit if cost or privacy review pushes back.

**Q2 — Clinician self-ID.** Should the bridge require the clinician to
type a name + role before viewing? Pros: better audit trail. Cons:
friction at the bedside. Recommend optional self-ID at session start,
prominently logged to `audit_log` but not blocking.

**Q3 — Audit log writes.** Bridge runs rules via `api-gateway`, which
already writes `audit_log` rows for rule firings. Confirm the audit row
includes a `capture_hash` field (sha256 of the MedLens capture) so we
can correlate later without storing the capture itself. May need a
small `audit_log` schema add — track in a follow-up issue.

**Q4 — DEA/NPI capture.** Out of scope for MVP. Defer until a
clinician partner asks for it.

## Milestones

- **M1 — Scaffold.** Empty Next.js app, "Hello bridge" landing page,
  deployed to Vercel under `bridge.carebridge.health`.
- **M2 — Pairing.** QR/code entry → mocked capture fetch → static
  timeline render.
- **M3 — Rule wiring.** Real tRPC call to `api-gateway`, real rule
  output rendered with citations.
- **M4 — MedLens endpoint.** Real `POST /v1/pair` and
  `GET /v1/captures/:id` in MedLens; bridge wired to live capture.
- **M5 — Audit log + capture-hash.** Audit writes confirmed,
  `capture_hash` schema add merged.
- **M6 — Disclaimer + self-ID UI.** PostMortemBanner, optional
  clinician name/role input.

Each milestone is one PR. M1–M3 are CareBridge-side; M4 is MedLens-side;
M5 spans both repos.

## What This Doc Is Not

This is a scope doc, not a design doc. It deliberately leaves the
following open:

- Exact rule selection on the bridge (probably the full DETERIORATION
  family + cross-specialty + critical-value rules — TBD on M3).
- UI design for the timeline (the existing clinician-portal timeline
  component is a starting point but may need a denser bedside variant).
- Whether the bridge needs a dark-mode default for the bedside (likely
  yes — defer to M6).

## Status

Scope only. Not yet implemented. Tracked as Task #117 in the founding
milestone session.
