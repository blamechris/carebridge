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

## Relay Endpoints (live on the bridge app)

Per **D1 — relay transport**, the relay endpoints live on the bridge
app itself (Next.js API routes on the same Vercel deployment), not on
MedLens. MedLens is a client to these endpoints:

| Endpoint | Caller | Purpose |
|---|---|---|
| `POST /api/v1/pair` | MedLens | Caregiver phone uploads an encrypted ciphertext blob, gets back `{ capture_id, display_code, expires_at, decryption_key }`. The relay keeps the ciphertext for 15 min and never sees the decryption key after this response. |
| `GET /api/v1/captures/[id]` | Bridge UI | Bridge fetches the encrypted envelope by `capture_id`; decryption happens client-side using the key from the QR/code. |

Wire contract types: `BridgePairRecord`, `BridgePairRequest`,
`BridgeCaptureEnvelope`, `BridgeQrPayload` — see
`packages/shared-types/src/bridge-protocol.ts` and the Zod schemas in
`bridge-protocol.schemas.ts`. The decrypted payload is a FHIR R4 Bundle
(MedLens already emits this via its outbox builder; the bridge consumes
it through the existing `services/fhir-gateway` mappers).

**Out-of-repo work**: MedLens needs a "Share with clinician" UI that
(a) builds a FHIR R4 bundle from the local timeline, (b) AES-256-GCM
encrypts the bundle with a freshly-generated 256-bit key, (c) POSTs the
ciphertext to `/api/v1/pair`, (d) renders the returned token as a QR +
6-char display code. Tracked as a sibling PR in the MedLens repo.

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

## Decisions

**D1 — Token transport: relay.** Caregiver phone uploads an
encrypted-at-rest blob to a CareBridge edge cache (Cloudflare R2 or
Vercel KV with a 15-min TTL) when the share button is pressed. Bridge
fetches from the relay with the paired token. Considered alternatives:
local-net HTTP server on the caregiver phone (rejected — hospital WiFi
is too unreliable) and multi-frame QR (rejected — capture payloads
will routinely exceed safe QR scan reliability).

Privacy posture: the relay holds an opaque encrypted blob; the
decryption key travels in the paired token, which expires in 15
minutes and is single-use. The relay sees ciphertext only.

**D2 — Clinician self-ID: optional, logged.** Bridge prompts for
clinician name + role at session start but does not require it. If
entered, it is written prominently to `audit_log`. Friction at the
bedside is a real safety risk (clinicians abandon tools that get in
the way during acute care); a soft prompt + permanent audit trail
balances both concerns.

**D3 — Audit log capture-hash add.** `audit_log` schema gains a
nullable `capture_hash` column (sha256 of the MedLens capture body).
Lets us correlate bridge sessions to flag firings without storing the
capture itself. Tracked as a follow-up issue once this scope merges.

**D4 — DEA/NPI capture: deferred.** Out of scope for MVP. Defer until
a clinician partner asks for it.

## Milestones

- **M1 — Scaffold.** Empty Next.js app, "Hello bridge" landing page,
  deployed to Vercel under `bridge.carebridge.health`.
- **M2 — Pairing.** Relay endpoints (`POST /api/v1/pair`,
  `GET /api/v1/captures/[id]`), QR/code entry on the landing page,
  session route renders a captured FHIR bundle from a local fixture.
- **M3 — MedLens client.** "Share with clinician" UI in MedLens —
  builds a FHIR bundle from the local timeline, encrypts client-side,
  POSTs to the relay, renders QR + 6-char code.
- **M4 — Rule wiring.** Bridge calls `api-gateway`/`ai-oversight`
  against the decrypted bundle, real rule output rendered with
  citations.
- **M5 — Audit log + capture-hash.** Audit writes confirmed,
  `capture_hash` schema add merged.
- **M6 — Self-ID UI polish.** Optional clinician name/role input.

Each milestone is one PR. M1, M2, M4, M5, M6 are CareBridge-side;
M3 is MedLens-side; M5 spans both repos.

## What This Doc Is Not

This is a scope doc, not a design doc. The four core decisions
(transport, self-ID, audit, DEA/NPI) are now locked above. It
deliberately leaves the following implementation-level details open:

- Exact rule selection on the bridge (probably the full DETERIORATION
  family + cross-specialty + critical-value rules — TBD on M3).
- UI design for the timeline (the existing clinician-portal timeline
  component is a starting point but may need a denser bedside variant).
- Whether the bridge needs a dark-mode default for the bedside (likely
  yes — defer to M6).

## Status

Scope only. Not yet implemented. Tracked as Task #117 in the founding
milestone session.
