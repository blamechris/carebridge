import { NextResponse } from "next/server";
import {
  bridgePairRequestSchema,
  type BridgePairResponse,
  type BridgeCaptureEnvelope,
} from "@carebridge/shared-types";
import { generatePairResponse } from "@/lib/pair-token";
import { relayStore, RELAY_TTL_MS } from "@/lib/relay-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/v1/pair
 *
 * Caregiver phone uploads an encrypted ciphertext blob. The relay
 * mints a capture_id + display_code + expires_at, stores the envelope
 * under display_code with a 15-min TTL, and returns those three
 * fields.
 *
 * The relay deliberately does NOT see the AES-256-GCM key that
 * encrypted the ciphertext. The MedLens client generates the key
 * locally, encrypts locally, posts ciphertext only, and embeds the
 * key in the QR payload alongside the response fields.
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
  const response: BridgePairResponse = generatePairResponse({
    now,
    ttl_ms: RELAY_TTL_MS,
    crypto,
  });

  const envelope: BridgeCaptureEnvelope = {
    capture_id: response.capture_id,
    ciphertext: parsed.data.ciphertext,
    uploaded_at: new Date(now).toISOString(),
    expires_at: response.expires_at,
  };

  relayStore.put(response.display_code, envelope, parsed.data.caregiver_label, now);

  return NextResponse.json(response, { status: 201 });
}
