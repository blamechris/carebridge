/**
 * RS384 keypair generator for Epic SMART Backend Services (#389).
 *
 * Generates an RSA 2048-bit keypair (Epic's minimum), writes the private
 * key as PEM to disk, and converts the public key to JWK form ready for
 * upload at open.epic.com → App Settings → Public Keys.
 *
 * Why a custom helper instead of `openssl genrsa` + manual JWK conversion:
 *  - Single command sets correct file permissions (0600) on the private
 *    key, hard to get wrong with `openssl` defaults.
 *  - JWK output already includes the `alg: "RS384"` and `kid` fields
 *    Epic expects, with the right base64url encoding (not base64).
 *  - No openssl version differences (LibreSSL on macOS vs OpenSSL on
 *    Linux produce subtly different PEM headers).
 */
import { generateKeyPairSync, createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface GeneratedKeyPair {
  /** Filesystem path the private key PEM was written to. */
  privateKeyPath: string;
  /** Public key as a JWK ready to paste into open.epic.com. */
  publicJwk: PublicJwk;
  /** Key id — matches the `kid` claim in JWT assertions. */
  kid: string;
  /**
   * Public key in SPKI PEM form. Exposed alongside the JWK so callers
   * can pass it through helpers expecting PEM (e.g. fingerprint
   * printing) without having to re-derive it from the on-disk private
   * key.
   */
  publicKeyPem: string;
}

export interface PublicJwk {
  kty: "RSA";
  alg: "RS384";
  use: "sig";
  kid: string;
  n: string;
  e: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/**
 * Convert an RSA public key (PEM) → JWK form suitable for upload at
 * open.epic.com. The exported PEM is SPKI; we strip the ASN.1 envelope
 * and pull out the modulus (`n`) and exponent (`e`).
 */
function rsaPublicPemToJwk(spkiPem: string, kid: string): PublicJwk {
  const der = pemToDer(spkiPem);
  // Parse the SPKI structure to extract the RSA public key. RFC 5280
  // §4.1.2.7 SubjectPublicKeyInfo: SEQUENCE { algorithm, subjectPublicKey BIT STRING }
  // For RSA, the BIT STRING wraps RSAPublicKey: SEQUENCE { modulus INTEGER, publicExponent INTEGER }
  // We walk the DER manually rather than pulling in an ASN.1 lib — the
  // structure is small and stable.
  const rsaKey = extractRsaPublicKey(der);
  return {
    kty: "RSA",
    alg: "RS384",
    use: "sig",
    kid,
    n: base64UrlEncode(rsaKey.modulus),
    e: base64UrlEncode(rsaKey.exponent),
  };
}

function pemToDer(pem: string): Buffer {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  return Buffer.from(body, "base64");
}

/**
 * Walk an SPKI-encoded RSA public key and pull out modulus + exponent.
 * The structure is:
 *   SEQUENCE {                             // outer SPKI
 *     SEQUENCE { OID, NULL }               // algorithm identifier
 *     BIT STRING {
 *       SEQUENCE {                         // RSAPublicKey
 *         INTEGER modulus
 *         INTEGER exponent
 *       }
 *     }
 *   }
 */
function extractRsaPublicKey(spki: Buffer): {
  modulus: Buffer;
  exponent: Buffer;
} {
  let cursor = 0;
  // outer SEQUENCE
  if (spki[cursor++] !== 0x30) throw new Error("SPKI: expected SEQUENCE");
  cursor += readLength(spki, cursor).bytes;
  // algorithm identifier SEQUENCE — skip
  if (spki[cursor++] !== 0x30) throw new Error("SPKI: expected algorithm SEQUENCE");
  const algLen = readLength(spki, cursor);
  cursor += algLen.bytes + algLen.value;
  // BIT STRING
  if (spki[cursor++] !== 0x03) throw new Error("SPKI: expected BIT STRING");
  const bitLen = readLength(spki, cursor);
  cursor += bitLen.bytes;
  if (spki[cursor++] !== 0x00)
    throw new Error("SPKI: expected 0 unused bits in BIT STRING");
  // inner SEQUENCE RSAPublicKey
  if (spki[cursor++] !== 0x30) throw new Error("SPKI: expected RSAPublicKey SEQUENCE");
  cursor += readLength(spki, cursor).bytes;
  // INTEGER modulus
  if (spki[cursor++] !== 0x02) throw new Error("SPKI: expected INTEGER modulus");
  const modLen = readLength(spki, cursor);
  cursor += modLen.bytes;
  let modulus = spki.subarray(cursor, cursor + modLen.value);
  // RSA moduli have a leading 0x00 sign byte; strip it so the JWK `n`
  // is the unsigned big-endian magnitude per RFC 7518 §6.3.1.
  if (modulus[0] === 0x00) modulus = modulus.subarray(1);
  cursor += modLen.value;
  // INTEGER exponent
  if (spki[cursor++] !== 0x02) throw new Error("SPKI: expected INTEGER exponent");
  const expLen = readLength(spki, cursor);
  cursor += expLen.bytes;
  const exponent = spki.subarray(cursor, cursor + expLen.value);
  return { modulus, exponent };
}

function readLength(
  buf: Buffer,
  offset: number,
): { value: number; bytes: number } {
  const first = buf[offset];
  if (first === undefined) throw new Error("DER: truncated length");
  if (first < 0x80) return { value: first, bytes: 1 };
  const numBytes = first & 0x7f;
  let value = 0;
  for (let i = 1; i <= numBytes; i++) {
    const b = buf[offset + i];
    if (b === undefined) throw new Error("DER: truncated length");
    value = (value << 8) | b;
  }
  return { value, bytes: numBytes + 1 };
}

export interface GenerateOptions {
  /** Path the private key PEM is written to. */
  privateKeyPath: string;
  /**
   * Override the kid. Defaults to a fresh UUID — fine for first-time
   * setup. Rotations typically generate a NEW kid so the previous JWKS
   * entry can be retained alongside the new one until Epic re-fetches.
   */
  kid?: string;
  /**
   * Override the keypair generator (test injection). Defaults to the
   * Node crypto generator.
   */
  generator?: () => { privatePem: string; publicPem: string };
}

/**
 * Generate an RS384 keypair, persist the private key, and return the
 * public JWK + kid for upload to open.epic.com.
 */
export function generateKeypair(options: GenerateOptions): GeneratedKeyPair {
  const kid = options.kid ?? generateKid();
  const generated =
    options.generator?.() ??
    (() => {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", {
        modulusLength: 2048,
      });
      return {
        privatePem: privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
        publicPem: publicKey
          .export({ type: "spki", format: "pem" })
          .toString(),
      };
    })();

  mkdirSync(dirname(options.privateKeyPath), { recursive: true });
  // Create the file with 0600 from the start. `writeFileSync` accepts a
  // `mode` option that's applied at open() time, closing the race window
  // where a separate chmod after writeFileSync would leave the key
  // world-readable for the few syscalls in between. The `flag: "w"`
  // matches the default but is explicit for the security audit trail.
  writeFileSync(options.privateKeyPath, generated.privatePem, {
    encoding: "utf8",
    mode: 0o600,
    flag: "w",
  });
  // Belt-and-braces: chmod after the write in case an existing file
  // was overwritten and the new mode wasn't applied (older Node
  // versions did NOT update mode on overwrite of an existing file).
  chmodSync(options.privateKeyPath, 0o600);

  const publicJwk = rsaPublicPemToJwk(generated.publicPem, kid);
  return {
    privateKeyPath: options.privateKeyPath,
    publicJwk,
    kid,
    publicKeyPem: generated.publicPem,
  };
}

/**
 * Default kid generator — emits a fresh UUID v4 from crypto.randomUUID
 * per invocation. Factored out so tests can stub kid generation for
 * deterministic fixtures. The name was previously misleading; this is
 * NOT a UUID v5 (no namespacing) and is NOT stable across invocations.
 */
function generateKid(): string {
  return randomUUID();
}

/**
 * Convenience: sha-256 fingerprint of a public PEM, useful for printing
 * a short identifier alongside the kid for human verification at upload
 * time ("is this the same key I just generated?").
 */
export function publicKeyFingerprint(spkiPem: string): string {
  const der = pemToDer(spkiPem);
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}
