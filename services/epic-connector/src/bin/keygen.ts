#!/usr/bin/env node
/**
 * `carebridge-epic-keygen` — one-shot RS384 keypair setup (#389).
 *
 * Usage:
 *   pnpm epic:keygen [--out <path>] [--kid <id>]
 *
 * Defaults:
 *   --out  ~/.carebridge/epic-private.pem
 *   --kid  fresh UUID v4
 *
 * On success, prints:
 *  1. The path the private key was written to (chmod 0600).
 *  2. The kid to set as EPIC_JWT_KID.
 *  3. The public JWK to paste into open.epic.com → App Settings →
 *     Public Keys.
 *  4. The .env snippet to copy into your local .env.local.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { generateKeypair, publicKeyFingerprint } from "../keygen.js";

interface Args {
  out: string;
  kid?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    out: join(homedir(), ".carebridge", "epic-private.pem"),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--out" || arg === "-o") {
      const next = argv[++i];
      if (!next) throw new Error("--out requires a path argument");
      args.out = next;
    } else if (arg === "--kid") {
      const next = argv[++i];
      if (!next) throw new Error("--kid requires an id argument");
      args.kid = next;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function printHelp(): void {
  // eslint-disable-next-line no-console
  console.log(
    `Usage: carebridge-epic-keygen [--out <path>] [--kid <id>]\n\n` +
      `Generates an RS384 keypair for Epic SMART Backend Services and\n` +
      `prints the public JWK for upload at open.epic.com.\n\n` +
      `Options:\n` +
      `  --out, -o   Path to write the private key PEM (chmod 0600).\n` +
      `              Default: ~/.carebridge/epic-private.pem\n` +
      `  --kid       Key id to embed in the JWK. Default: fresh UUID.\n` +
      `  --help, -h  Show this help.\n`,
  );
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const result = generateKeypair({
    privateKeyPath: args.out,
    kid: args.kid,
  });

  const fingerprint = publicKeyFingerprint(result.publicKeyPem);

  /* eslint-disable no-console */
  console.log("\n=== Epic SMART Backend Services keypair generated ===\n");
  console.log(`Private key:    ${result.privateKeyPath}  (chmod 0600)`);
  console.log(`Key id (kid):   ${result.kid}`);
  console.log(`Fingerprint:    sha256:${fingerprint}\n`);
  console.log("Public JWK — paste this at open.epic.com → App Settings → Public Keys:\n");
  console.log(JSON.stringify(result.publicJwk, null, 2));
  console.log("\n.env.local snippet:\n");
  console.log(`EPIC_CLIENT_ID=<paste your Non-Production Client ID here>`);
  console.log(`EPIC_PRIVATE_KEY_PATH=${result.privateKeyPath}`);
  console.log(`EPIC_JWT_KID=${result.kid}\n`);
  console.log(
    "Defaults to Epic's sandbox (fhir.epic.com). Override " +
      "EPIC_TOKEN_URL and EPIC_FHIR_BASE_URL for production.",
  );
  /* eslint-enable no-console */
}

try {
  main();
} catch (err) {
  // eslint-disable-next-line no-console
  console.error(
    `epic-keygen failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
