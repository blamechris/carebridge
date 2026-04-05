# MedLens ↔ CareBridge Integration

## Overview

MedLens is a local-first React Native app (Expo) that lets patients and families
capture, organize, and trend hospital and home care data by photographing IV bags,
lab reports, and vitals monitors using on-device OCR.

CareBridge is the clinical platform used by physicians and nurses. Integration
between the two lets patients see their hospital data in MedLens and lets
clinicians see patient-captured observations in CareBridge.

## Data Flow

```
CareBridge (clinical record)  ◄──── export ────  MedLens (patient view)
CareBridge (enriched record)  ────── import ────► MedLens (patient captures)
```

**CareBridge → MedLens (pull):**
- Medications from the hospital/clinic
- Vital signs recorded by nursing staff
- Lab results as they are resulted

**MedLens → CareBridge (push):**
- Home vitals captured by the patient
- Lab results photographed by family
- Patient-reported events (symptoms, observations)

## Setup (Patient)

1. Log into CareBridge patient portal
2. Navigate to **Settings → MedLens Sync**
3. Click **Generate Sync Token**
4. Select which data to share:
   - ☑ Share my medications with MedLens
   - ☑ Share my lab results with MedLens
   - ☑ Allow MedLens to submit home vitals
5. Copy the generated token (format: `ml_XXXXXXXXXX`)
6. In MedLens: **Settings → CareBridge Sync → Connect → Enter token**

## Token Scopes

| Scope | Description |
|---|---|
| `read:medications` | MedLens can pull medication list |
| `read:vitals` | MedLens can pull vital signs history |
| `read:labs` | MedLens can pull lab results |
| `write:vitals` | MedLens can push home vitals |
| `write:labs` | MedLens can push photographed lab results |
| `write:events` | MedLens can push patient observations |

Tokens expire after 30 days by default. Patients can revoke tokens at any time
from the CareBridge portal.

## API Reference

All endpoints are under the `medlensBridge` tRPC router:

### `medlensBridge.createSyncToken`
Creates a new sync token for a patient. Called by CareBridge portal.

### `medlensBridge.exportForMedLens`
Returns all of a patient's clinical data in MedLens-compatible format.
Requires a valid sync token with at least `read:medications` scope.

**Request:**
```typescript
{ sync_token: "ml_...", since?: "2026-04-01T00:00:00Z" }
```

**Response:** `MedLensExportBundle` (see `packages/shared-types/src/medlens.ts`)

### `medlensBridge.importFromMedLens`
Accepts patient-captured observations from MedLens.
Requires a valid sync token with `write:vitals` scope.

**Request:** `MedLensImportBundle` (see `packages/shared-types/src/medlens.ts`)

**Response:** `MedLensImportResult` with accepted/skipped counts

## Data Quality

Imported MedLens data is filtered for quality:
- Vitals with confidence < 0.6 are rejected
- Lab results with confidence < 0.5 are skipped
- All imported records are tagged `source_system: "medlens"`
- Clinical staff can filter by source to distinguish hospital vs. patient-captured data

## Privacy Notes

- Tokens are scoped — a patient controls exactly what MedLens can see/write
- Tokens expire and can be revoked
- Every sync operation is logged in the HIPAA audit trail (`medlens_sync_log`)
- MedLens operates offline-first — sync is fully opt-in
- De-identified MedLens data (confidence 0.6+) enriches the clinical record

## Architecture

```
apps/patient-portal                    MedLens (mobile app)
      │                                      │
      │ createSyncToken                      │ exportForMedLens
      │ revokeSyncToken                      │ importFromMedLens
      ▼                                      ▼
services/fhir-gateway
  └── src/medlens-bridge.ts  ◄──── token validation ──── medlens_sync_tokens
                              ◄──── reads ────────────── medications, vitals, lab_panels
                              ──── writes ──────────────► vitals, lab_panels, events
```

## Future Work

- [ ] Webhook push from CareBridge to MedLens when new lab results are available
- [ ] Family sharing: multiple MedLens devices authorized for the same patient
- [ ] FHIR R4 export: MedLens requests FHIR Bundles (when FHIR gateway is complete)
- [ ] Two-way conflict resolution when CareBridge and MedLens have conflicting vitals
