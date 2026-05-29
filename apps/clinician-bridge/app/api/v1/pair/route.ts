import { NextResponse } from "next/server";
import {
  bridgePairRequestSchema,
  type BridgePairRecord,
  type BridgeCaptureEnvelope,
} from "@carebridge/shared-types";
import { generatePairRecord } from "@/lib/pair-token";
import { relayStore, RELAY_TTL_MS } from "@/lib/relay-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/pair
 *
 * Caregiver phone uploads an encrypted ciphertext blob. The relay
 * generates a pair record (capture_id, display_code, decryption_key,
 * expires_at), stores the envelope under display_code with a 15-min
 * TTL, and returns the pair record.
 *
 * The decryption key is in the response body — once returned, the
 * relay does not retain it. The MedLens client embeds it in the QR
 * payload, which is the only place it lives until the bridge scans.
 */
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_json", message: "Body must be JSON" },
      { status: 400 },
    );
  }

  const parsed = bridgePairRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "invalid_request",
        message: parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
      },
      { status: 400 },
    );
  }

  const now = Date.now();
  const pair: BridgePairRecord = generatePairRecord({
    now,
    ttl_ms: RELAY_TTL_MS,
    crypto,
  });

  const envelope: BridgeCaptureEnvelope = {
    capture_id: pair.capture_id,
    ciphertext: parsed.data.ciphertext,
    uploaded_at: new Date(now).toISOString(),
    expires_at: pair.expires_at,
  };

  relayStore.put(pair.display_code, envelope, parsed.data.caregiver_label, now);

  return NextResponse.json(pair, { status: 201 });
}
