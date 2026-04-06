/**
 * Key rotation script: re-encrypts all PHI columns with the current key.
 *
 * Usage:
 *   PHI_ENCRYPTION_KEY=<new-64-hex> PHI_ENCRYPTION_KEY_PREVIOUS=<old-64-hex> \
 *     DATABASE_URL=<url> tsx packages/db-schema/src/rotate-keys.ts
 *
 * For each patient row the script decrypts every PHI column (trying the current
 * key first, falling back to the previous key) and re-encrypts with the current
 * key. Already-current rows are skipped — safe to run multiple times.
 *
 * No PII is logged; only row counts are printed.
 */
import postgres from "postgres";
import { encrypt, decryptWithFallback } from "./encryption.js";

const PHI_COLUMNS = [
  "date_of_birth",
  "mrn",
  "insurance_id",
  "emergency_contact_name",
  "emergency_contact_phone",
] as const;

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const currentKey = process.env.PHI_ENCRYPTION_KEY;
  if (!currentKey) {
    throw new Error("PHI_ENCRYPTION_KEY environment variable is required");
  }

  const previousKey = process.env.PHI_ENCRYPTION_KEY_PREVIOUS;
  if (!previousKey) {
    throw new Error(
      "PHI_ENCRYPTION_KEY_PREVIOUS environment variable is required for key rotation"
    );
  }

  const sql = postgres(databaseUrl);

  try {
    const rows = await sql`SELECT id, ${sql(PHI_COLUMNS as unknown as string[])} FROM patients`;

    console.log(`Found ${rows.length} patient rows to process.`);

    let rotatedCount = 0;
    let skippedCount = 0;
    let errorCount = 0;

    for (const row of rows) {
      const updates: Record<string, string> = {};

      for (const col of PHI_COLUMNS) {
        const value = row[col];
        if (value == null || typeof value !== "string") continue;

        try {
          const plaintext = decryptWithFallback(value, currentKey, previousKey);
          // Re-encrypt with the current key
          updates[col] = encrypt(plaintext, currentKey);
        } catch (err) {
          console.error(`Error processing row ${row.id}, column ${col}: decryption failed`);
          errorCount++;
        }
      }

      if (Object.keys(updates).length > 0) {
        await sql`UPDATE patients SET ${sql(updates)} WHERE id = ${row.id}`;
        rotatedCount++;
      } else {
        skippedCount++;
      }
    }

    console.log(
      `Key rotation complete. Rotated: ${rotatedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`
    );

    if (errorCount > 0) {
      process.exit(1);
    }
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error("Key rotation failed:", err);
  process.exit(1);
});
