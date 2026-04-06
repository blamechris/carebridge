/**
 * One-time migration script to encrypt existing plaintext PHI columns.
 *
 * Usage:
 *   PHI_ENCRYPTION_KEY=<64-hex-chars> DATABASE_URL=<url> tsx packages/db-schema/src/encrypt-existing.ts
 *
 * This script reads all rows from the patients table, checks whether each
 * PHI field is already encrypted (by looking for the iv:authTag:ciphertext
 * format), and encrypts any plaintext values in place.
 *
 * Safe to run multiple times — already-encrypted values are skipped.
 */
import postgres from "postgres";
import { encrypt, decrypt, hmacForIndex } from "./encryption.js";

const ENCRYPTED_PATTERN = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]+$/;

const PHI_COLUMNS = [
  "date_of_birth",
  "mrn",
  "insurance_id",
  "emergency_contact_name",
  "emergency_contact_phone",
] as const;

function isAlreadyEncrypted(value: string): boolean {
  return ENCRYPTED_PATTERN.test(value);
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const key = process.env.PHI_ENCRYPTION_KEY;
  if (!key) {
    throw new Error("PHI_ENCRYPTION_KEY environment variable is required");
  }

  const sql = postgres(databaseUrl);

  try {
    const rows = await sql`SELECT id, mrn_hmac, ${sql(PHI_COLUMNS as unknown as string[])} FROM patients`;

    console.log(`Found ${rows.length} patient rows to process.`);

    let updatedCount = 0;

    for (const row of rows) {
      const updates: Record<string, string> = {};

      for (const col of PHI_COLUMNS) {
        const value = row[col];
        if (value != null && typeof value === "string" && !isAlreadyEncrypted(value)) {
          updates[col] = encrypt(value, key);
        }
      }

      // Backfill mrn_hmac for rows that have an MRN but no HMAC yet
      if (row.mrn != null && row.mrn_hmac == null) {
        const plainMrn = isAlreadyEncrypted(row.mrn as string)
          ? decrypt(row.mrn as string, key)
          : row.mrn as string;
        updates.mrn_hmac = hmacForIndex(plainMrn);
      }

      if (Object.keys(updates).length > 0) {
        await sql`UPDATE patients SET ${sql(updates)} WHERE id = ${row.id}`;
        updatedCount++;
      }
    }

    console.log(`Done. Encrypted ${updatedCount} of ${rows.length} rows.`);
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
