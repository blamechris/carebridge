# @carebridge/epic-connector

Epic SMART on FHIR integration for CareBridge.

Issue #389 ships the authentication layer — RS384 client-assertion JWT,
OAuth 2.0 client-credentials token exchange, expiry-aware caching, and
SMART configuration discovery. Follow-ups will add the typed FHIR
client (#390), sync worker (#391), App Launch (#392), and outbound
flag push (#393).

## First-time setup

```bash
# 1. Generate an RS384 keypair and grab the public JWK
pnpm --filter @carebridge/epic-connector epic:keygen

# Output includes:
#   - private key path  (default: ~/.carebridge/epic-private.pem, 0600)
#   - kid               (UUID to embed in JWT assertions)
#   - public JWK        (paste at open.epic.com → App Settings → Public Keys)
#   - .env.local snippet

# 2. Register the public JWK at open.epic.com.
#    App Settings → Public Keys → "Add" → paste the JWK output.

# 3. Add to .env.local (already gitignored):
#    EPIC_CLIENT_ID=<your Non-Production Client ID>
#    EPIC_PRIVATE_KEY_PATH=~/.carebridge/epic-private.pem
#    EPIC_JWT_KID=<the kid from step 1>

# Defaults to fhir.epic.com sandbox. Override EPIC_TOKEN_URL and
# EPIC_FHIR_BASE_URL for production.
```

## Use

```ts
import { loadEpicConfig, EpicTokenClient } from "@carebridge/epic-connector";

const config = loadEpicConfig();
const client = new EpicTokenClient(config);

const token = await client.getAccessToken();
// → use as Authorization: Bearer ${token} on FHIR requests
```

The token client caches the response and refreshes 60s before expiry.
Call `client.invalidate()` after a 401 to force a fresh assertion.

## Sync fan-out overrides (#1098)

Epic enforces per-resource search-parameter restrictions, so the sync
worker fans out across a small set of values for `Observation` and
`MedicationRequest`. The defaults match CareBridge's MVP (what the
persistence layer maps + what the AI oversight pipeline acts on); a
tenant whose workflow needs other categories/statuses can override
without a code change.

| Env var | Default | Notes |
|---|---|---|
| `EPIC_OBSERVATION_CATEGORIES` | `vital-signs,laboratory` | Comma-separated FHIR observation-category codes. Whitespace trimmed; empty segments and duplicates dropped. All-empty or whitespace-only values fall back to the default (silently disabling Observation sync is worse than refusing the misconfig). |
| `EPIC_MEDICATION_REQUEST_STATUS` | `active` | Single FHIR MedicationRequest status. Multi-status fan-out implementation is tracked under #1114 (#1105 covers the related test-placeholder cleanup). |

> **Note:** widening either set fetches more from Epic, but the CareBridge persistence layer today only maps `Observation.category` ∈ `{vital-signs, laboratory}` (→ `vitals`/`lab_results`) and `MedicationRequest.status = "active"` (→ AI oversight pipeline). Categories or statuses outside that set are fetched and counted in `SyncResult` but won't appear in internal tables — useful for surfacing scope/auth issues via `skipped_sub_resources` (#1097), not for end-user data display, until the matching persistence work lands.

Examples:

```bash
# Primary-care tenant — adds social history and exam findings
EPIC_OBSERVATION_CATEGORIES=vital-signs,laboratory,social-history,exam

# Med-rec tenant — wants completed/stopped MedicationRequest history
EPIC_MEDICATION_REQUEST_STATUS=completed
```

## Test

```bash
pnpm --filter @carebridge/epic-connector test
```

Tests are offline: JWT signatures verify against an ephemeral keypair,
token exchange uses a mocked fetch, JWK conversion round-trips through
Node's crypto. The end-to-end sandbox test is intentionally not in CI
— it requires real Epic credentials and runs locally when present.
