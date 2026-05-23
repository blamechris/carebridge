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

## Test

```bash
pnpm --filter @carebridge/epic-connector test
```

Tests are offline: JWT signatures verify against an ephemeral keypair,
token exchange uses a mocked fetch, JWK conversion round-trips through
Node's crypto. The end-to-end sandbox test is intentionally not in CI
— it requires real Epic credentials and runs locally when present.
