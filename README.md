# CareBridge

A modern healthcare platform built to replace legacy systems like Epic MyChart, with an AI oversight layer that proactively detects cross-specialty clinical gaps — the kind that individual specialists often miss.

## The Problem It Solves

A cancer patient with a known DVT history presents with a new headache. Her oncologist adjusts her chemo. Her interventional radiologist checks her IVC filter. Neither flags the headache. But the combination — malignancy-driven hypercoagulability, established venous thromboembolism, and new neurological symptoms — is a textbook stroke risk pattern.

CareBridge catches this automatically.

---

## Architecture Overview

CareBridge is a TypeScript fullstack monorepo. All clinical data mutations flow through an event queue where a hybrid rules engine and Claude LLM review evaluate the patient's complete picture across specialties — not just the latest chart entry.

```
Clinician enters data
        │
        ▼
   API Gateway (tRPC)
        │
        ▼
 Clinical services (vitals, labs, meds, notes)
        │    saves to PostgreSQL
        │    emits to Redis queue
        ▼
  AI Oversight Worker (BullMQ)
        │
        ├──► Deterministic rules (cross-specialty patterns, drug interactions, critical values)
        │         └──► Immediate critical flags
        │
        └──► LLM review (Claude API — full patient context)
                  └──► Nuanced clinical flags
        │
        ▼
 Notifications → Clinician Portal (flags dashboard)
```

---

## Monorepo Structure

```
carebridge/
├── packages/               # Shared libraries
│   ├── shared-types        # Canonical TypeScript types for the entire system
│   ├── db-schema           # Drizzle ORM schema, migrations, DB connection
│   ├── validators          # Zod schemas for all API input validation
│   ├── medical-logic       # Vital danger zones, lab validation, trend analysis
│   ├── ai-prompts          # Versioned Claude prompts + context builder
│   └── fhir-utils          # FHIR R4 format converters
│
├── services/               # Backend microservices
│   ├── api-gateway         # tRPC entrypoint, auth middleware, audit log (port 4000)
│   ├── clinical-data       # Vitals, labs, medications, procedures CRUD + event emission
│   ├── clinical-notes      # SOAP/Progress note templates, versioning, signing
│   ├── ai-oversight        # Rules engine + LLM review + flag management
│   ├── auth                # JWT authentication + session management
│   ├── patient-records     # Patient demographics + care team management
│   ├── notifications       # Alert delivery (in-app, email, SMS)
│   ├── fhir-gateway        # FHIR R4 import/export
│   └── scheduling          # Appointment scheduling
│
├── apps/
│   ├── clinician-portal    # Next.js 15 app for physicians and nurses (port 3000)
│   └── patient-portal      # Next.js 15 app for patients (port 3001)
│
├── tooling/
│   ├── seed/               # Database seeding with DVT scenario patient
│   └── scripts/            # CLI utilities
│
├── docker-compose.yml      # PostgreSQL 16 + Redis 7
├── turbo.json              # Turborepo task orchestration
└── pnpm-workspace.yaml
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | [Turborepo](https://turbo.build) + pnpm workspaces |
| Language | TypeScript (strict mode, ESM) |
| Backend framework | [Fastify](https://fastify.dev) |
| API layer | [tRPC](https://trpc.io) |
| Frontend | [Next.js 15](https://nextjs.org) + React 19 |
| Database ORM | [Drizzle ORM](https://orm.drizzle.team) |
| Database | PostgreSQL 16 |
| Job queue | [BullMQ](https://bullmq.io) + Redis 7 |
| Validation | [Zod](https://zod.dev) |
| AI review | [Claude API](https://anthropic.com) (`@anthropic-ai/sdk`) |

---

## Packages

### `@carebridge/shared-types`
Single source of truth for all TypeScript interfaces. No runtime dependencies — pure types only.

Key exports: `Vital`, `Medication`, `LabPanel`, `LabResult`, `ClinicalFlag`, `ClinicalEvent`, `Patient`, `User`, `UserRole`, `FlagSeverity`, `FlagStatus`, and more.

### `@carebridge/db-schema`
Drizzle ORM schema covering all entities, plus the database connection helper and migration runner.

Tables: `patients`, `diagnoses`, `allergies`, `care_team_members`, `users`, `sessions`, `vitals`, `lab_panels`, `lab_results`, `medications`, `med_logs`, `procedures`, `clinical_notes`, `note_versions`, `clinical_flags`, `review_jobs`, `notifications`, `fhir_resources`

### `@carebridge/validators`
Zod schemas for every API input. Used by services for input validation and by frontend for form validation.

### `@carebridge/medical-logic`
Clinical validation utilities:
- **`VITAL_DANGER_ZONES`** — per-type min/max/critical ranges (e.g., O2 sat critical below 85%)
- **`validateVital(type, value)`** — returns warnings + errors
- **`isCriticalVital(type, value)`** — boolean for rules engine
- **`validateLabResult(testName, value)`** — flags out-of-range values
- Trend analysis utilities (rising/falling/stable direction detection)

### `@carebridge/ai-prompts`
Versioned Claude prompts. The system prompt instructs the model to identify cross-specialty clinical concerns (not diagnose), respond in structured JSON, and filter out already-managed conditions.

Key exports:
- `CLINICAL_REVIEW_SYSTEM_PROMPT` — the core prompt
- `buildReviewPrompt(context)` — assembles patient context into the user message
- `parseReviewResponse(response)` — parses JSON response into `LLMFlagOutput[]`
- `PROMPT_VERSION` — semantic version for tracking prompt iterations

### `@carebridge/fhir-utils`
FHIR R4 format converters between CareBridge types and standard FHIR resources (Patient, Observation, Medication, DiagnosticReport).

---

## Services

### `api-gateway` — Port 4000
Fastify server that hosts the tRPC router. Handles authentication middleware (JWT validation), audit logging for all requests, and CORS.

Routes: `GET /health`, `POST /trpc/*`

### `clinical-data`
All clinical data CRUD: vitals, labs, medications, procedures. After every write, emits a `ClinicalEvent` to the Redis `clinical-events` queue for async AI review.

tRPC namespaces: `vitals.*`, `labs.*`, `medications.*`, `procedures.*`

### `clinical-notes`
Structured clinical documentation with template support. Notes are versioned and become immutable after signing.

Templates: **SOAP** (Subjective / Objective / Assessment / Plan), **Progress Note**

tRPC namespaces: `notes.*`, `templates.*`

Emits `note.saved` and `note.signed` events to the clinical-events queue.

### `ai-oversight`
The core safety layer. Has three components:

**Rules engine** — deterministic cross-specialty pattern detection:

| Rule ID | Pattern | Severity |
|---------|---------|----------|
| `ONCO-VTE-NEURO-001` | Cancer + VTE + neurological symptom | CRITICAL |
| `ANTICOAG-BLEED-001` | Anticoagulation + bleeding symptoms | CRITICAL |
| `CHEMO-NEUTRO-FEVER-001` | Chemotherapy + fever | CRITICAL |
| `RENAL-NSAID-001` | Renal impairment + NSAID use | WARNING |
| `CARDIAC-FLUID-001` | Heart failure + fluid overload symptoms | WARNING |
| `DIABETES-STEROID-001` | Diabetes + corticosteroid | WARNING |

Additional rule files cover critical vital values and drug-drug interactions.

**AI review service** — when rules don't fire (or in addition to them), the service assembles full patient context and calls the Claude API. Response is parsed into structured `ClinicalFlag` records.

**BullMQ worker** — subscribes to the `clinical-events` Redis queue with concurrency 5 and a 10-jobs/min rate limit to stay within API quotas.

tRPC namespaces: `flags.*`, `reviews.*`

### `auth`
JWT-based authentication with session tracking. Handles login, logout, signup, token refresh, and current-user lookup.

### `patient-records`
Patient enrollment and demographics. Manages the care team (add/remove providers, track specialties).

### `notifications`
Alert delivery via in-app, email, and SMS channels. BullMQ workers handle async delivery with retry logic.

### `fhir-gateway`
FHIR R4 import/export. Export converts CareBridge records to a FHIR Bundle; import converts FHIR resources into CareBridge types.

### `scheduling`
Appointment scheduling — create/read appointments by patient or provider.

---

## Apps

### `clinician-portal` — Port 3000
Next.js 15 app for physicians, nurses, and care coordinators. Uses tRPC client + React Query for data fetching.

Planned features: patient search, chart review (vitals/labs/meds/notes/procedures), structured note entry and signing, clinical flags dashboard with severity color-coding, flag acknowledgment and resolution workflows, care team management.

### `patient-portal` — Port 3001
Next.js 15 app for patients. Planned features: view own medical record, appointment booking, message center, symptom tracking, medication reminders.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org) 20+
- [pnpm](https://pnpm.io) 9+ (`npm install -g pnpm`)
- [Docker](https://docker.com) and Docker Compose

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/blamechris/carebridge.git
cd carebridge

# 2. Install dependencies
pnpm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL, REDIS_URL, ANTHROPIC_API_KEY, JWT_SECRET

# 4. Start PostgreSQL + Redis
docker-compose up -d

# 5. Run migrations
pnpm db:migrate

# 6. Seed development data
pnpm db:seed

# 7. Start everything
pnpm dev
```

### Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `DATABASE_URL` | PostgreSQL connection string | `postgresql://carebridge:carebridge@localhost:5432/carebridge` |
| `REDIS_URL` | Redis connection string | `redis://localhost:6379` |
| `ANTHROPIC_API_KEY` | Claude API key (required for AI review) | `sk-ant-...` |
| `JWT_SECRET` | Secret for signing JWTs | any long random string |

### Running Services

After `pnpm dev`:

| Service | URL |
|---------|-----|
| API Gateway | http://localhost:4000 |
| API Health | http://localhost:4000/health |
| Clinician Portal | http://localhost:3000 |
| Patient Portal | http://localhost:3001 |

### Dev Accounts

All accounts use password `password123`.

| Email | Role | Specialty |
|-------|------|-----------|
| `dr.smith@carebridge.dev` | Physician | Hematology/Oncology |
| `dr.jones@carebridge.dev` | Specialist | Interventional Radiology |
| `nurse.rachel@carebridge.dev` | Nurse | Oncology |
| `patient@carebridge.dev` | Patient | — |

---

## Development Workflow

### Key Commands

```bash
pnpm dev             # Start all services + apps (persistent, hot reload)
pnpm build           # Build all packages, services, apps
pnpm typecheck       # TypeScript type checking across all packages
pnpm lint            # ESLint across all packages

pnpm db:generate     # Generate Drizzle migrations from schema changes
pnpm db:migrate      # Apply pending migrations
pnpm db:seed         # Re-seed development data

pnpm clean           # Remove all dist/ directories
```

### Build Pipeline

Turborepo manages the build graph. Packages are built before the services that depend on them, and services are built before apps. The `dev` task runs persistently with no cache.

```
packages/* → services/* → apps/*
```

### Adding a Migration

1. Edit `packages/db-schema/src/schema/` to modify tables
2. Run `pnpm db:generate` to generate the migration SQL
3. Run `pnpm db:migrate` to apply it

### Adding a Clinical Rule

Rules live in `services/ai-oversight/src/rules/`. Add a new rule to `cross-specialty.ts` (or a new file) following the existing pattern:

```typescript
{
  id: "RULE-ID-001",
  evaluate(context: ReviewContext): RuleResult | null {
    // return null if rule doesn't apply
    // return { severity, category, summary, rationale, suggested_action } if it does
  }
}
```

Rules are evaluated synchronously before the LLM review, so they fire with zero additional latency.

### Code Conventions

- **TypeScript strict mode** everywhere
- **ESM** — `type: "module"` in all `package.json`, `.js` extensions in imports
- **Functional style** — prefer functions over classes
- **Dates** — always ISO 8601 strings (`new Date().toISOString()`)
- **UUIDs** — `crypto.randomUUID()` (no external packages)
- **Workspace packages** — import as `@carebridge/*`

### Commit Format

```
type(scope): short summary in present tense
```

Types: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `style`, `perf`

Scopes: `db`, `ai`, `notes`, `clinical`, `auth`, `gateway`, `portal`, `infra`

Examples:
```
feat(ai): add cross-specialty rule for cancer+vte+neuro pattern
fix(clinical): correct unit validation for blood pressure readings
refactor(db): normalize care team member table
```

---

## Testing the AI Oversight System

The seed data creates **Margaret Chen**, a 67-year-old patient with:
- Stage III breast cancer (docetaxel + paclitaxel)
- DVT, right lower extremity (IVC filter placed Feb 2026)
- Warfarin anticoagulation

To trigger rule `ONCO-VTE-NEURO-001`:

1. Log in as `dr.smith@carebridge.dev`
2. Open Margaret Chen's chart
3. Create a clinical note documenting a new headache symptom
4. Save (do not need to sign)
5. The AI oversight worker will pick up the `note.saved` event from the queue
6. Rule evaluation: cancer ✓ + VTE ✓ + neurological symptom ✓ → fires
7. A **CRITICAL** flag appears in the clinician portal:
   - *"Cancer patient with known VTE presenting with neurological symptoms — elevated stroke risk"*
   - Suggested action: urgent neurology evaluation, CT head / CTA

---

## Database Schema

```
Authentication
  users              id, email, password_hash, name, role, specialty, department
  sessions           id, user_id, token, expires_at

Patients
  patients           id, name, dob, mrn, insurance, primary_provider_id
  diagnoses          id, patient_id, icd10_code, description, status, onset_date
  allergies          id, patient_id, allergen, reaction, severity
  care_team_members  id, patient_id, provider_id, role, specialty

Clinical Data
  vitals             id, patient_id, type, value, unit, recorded_at
  lab_panels         id, patient_id, panel_name, ordered_by, collected_at
  lab_results        id, panel_id, test_name, value, unit, flag, reference_range
  medications        id, patient_id, name, dose, unit, route, frequency, status
  med_logs           id, medication_id, administered_at, administered_by, dose
  procedures         id, patient_id, name, cpt_code, status, performed_at

Documentation
  clinical_notes     id, patient_id, type, content, signed_by, signed_at, version
  note_versions      id, note_id, version_num, content, created_at

AI Oversight
  clinical_flags     id, patient_id, source, severity, category, summary,
                     rationale, suggested_action, status, rule_id,
                     acknowledged_by, resolved_by, dismiss_reason
  review_jobs        id, patient_id, status, rules_fired, flags_generated,
                     prompt_tokens, completion_tokens, elapsed_ms

Notifications
  notifications      id, recipient_id, recipient_type, type, content, status

FHIR
  fhir_resources     id, patient_id, resource_type, resource_id, content, imported_at
```

---

## Key Architecture Decisions

**Event-driven AI review** — Decouples data entry from AI processing. Clinicians don't wait for the LLM. BullMQ handles retries, rate limiting, and backpressure automatically.

**Deterministic rules before LLM** — Known patterns (drug interactions, critical vital values, the cross-specialty patterns above) fire immediately with zero LLM cost or latency. The LLM handles nuanced cases that rules can't encode.

**Versioned prompts** — `@carebridge/ai-prompts` tracks prompt versions like code. This enables A/B testing, regression testing when model versions change, and controlled rollbacks if a new prompt produces worse output.

**tRPC end-to-end** — Shared types between frontend and backend without a codegen step. Type errors in API calls surface at compile time.

**Drizzle ORM** — Schema-as-code with type inference. Migrations are plain SQL generated from the schema diff, not magic ORM transformations.

---

## Status

This is an active development project. Some services are fully implemented; others are scaffolded for future work:

| Component | Status |
|-----------|--------|
| DB schema + migrations | Complete |
| Seed data (DVT scenario) | Complete |
| AI oversight rules engine | Complete |
| AI oversight LLM review | Complete |
| clinical-data service | Complete |
| clinical-notes service | Complete |
| api-gateway | Complete |
| auth service | Complete |
| patient-records service | Complete |
| notifications service | Scaffolded |
| fhir-gateway service | Scaffolded |
| scheduling service | Scaffolded |
| clinician-portal UI | Scaffolded |
| patient-portal UI | Scaffolded |

---

## License

MIT

---

## Dedication

*For Lisa C. Bowen.*

This project exists because of her — and because of what the medical system failed to do for her.

Lisa was Chris's mother. She was let down by a system that was fragmented, inattentive, and too slow to connect the dots across her care. She died not from a condition that was untreatable, but from one that was unnoticed. The gaps between specialties, the missed signals, the absence of anyone looking at the full picture — these are not rare failures. They happen every day, to people whose names we never learn.

CareBridge is Chris's answer to that. Not as a tribute built in grief and set aside, but as a working system designed to catch exactly the kind of clinical gaps that took her life. Every rule in the AI oversight engine, every cross-specialty alert, every flag raised before a patient falls through the cracks — it is all built with her in mind.

No matter how large this system grows, no matter how many institutions or professionals use it, this will always be where it came from: a son who lost his mother to neglect, and decided to build something that might keep that from happening to someone else.

*Lisa C. Bowen. Remembered in every line of this codebase.*
