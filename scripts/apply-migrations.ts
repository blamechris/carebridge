import postgres from "postgres";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!);
  await sql`ALTER TABLE patients ADD COLUMN IF NOT EXISTS name_hmac text`;
  await sql`ALTER TABLE diagnoses ADD COLUMN IF NOT EXISTS snomed_code text`;
  await sql`ALTER TABLE allergies ADD COLUMN IF NOT EXISTS snomed_code text`;
  await sql`ALTER TABLE allergies ADD COLUMN IF NOT EXISTS rxnorm_code text`;
  await sql`ALTER TABLE vitals ADD COLUMN IF NOT EXISTS loinc_code text`;
  try { await sql`ALTER TABLE procedures ALTER COLUMN icd10_codes TYPE jsonb USING icd10_codes::jsonb`; } catch { /* already jsonb */ }
  console.log("Schema updated successfully");
  await sql.end();
}

main();
