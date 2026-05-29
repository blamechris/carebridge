import { NextResponse } from "next/server";
import { bridgeDisplayCodeSchema } from "@carebridge/shared-types";
import { relayStore } from "@/lib/relay-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/v1/captures/[code]
 *
 * Bridge fetches the encrypted envelope by display_code (6-char,
 * scanned from QR or typed by the clinician). Returns 404 on
 * not-found / expired / malformed code so a brute-force attacker
 * cannot distinguish "code never existed" from "code exists but
 * expired".
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ code: string }> },
): Promise<Response> {
  const { code: raw } = await ctx.params;
  const code = raw.toUpperCase();

  if (!bridgeDisplayCodeSchema.safeParse(code).success) {
    return notFound();
  }

  const hit = relayStore.get(code);
  if (!hit) return notFound();

  return NextResponse.json({
    envelope: hit.envelope,
    caregiver_label: hit.caregiver_label ?? null,
  });
}

function notFound(): Response {
  return NextResponse.json(
    { error: "not_found", message: "Capture not found or expired" },
    { status: 404 },
  );
}
