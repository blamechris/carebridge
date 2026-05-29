import { notFound } from "next/navigation";
import {
  bridgeDisplayCodeSchema,
  bridgeCaptureEnvelopeSchema,
} from "@carebridge/shared-types";
import { SessionView } from "./SessionView";

interface SessionPageProps {
  params: Promise<{ code: string }>;
}

interface CaptureFetchResult {
  envelope: import("@carebridge/shared-types").BridgeCaptureEnvelope;
  caregiver_label: string | null;
}

/**
 * Bridge session route. The code in the URL is the 6-char display_code.
 * We fetch the envelope server-side to keep the round-trip honest, but
 * decryption is reserved for M3 (the bridge does not yet have the key
 * — it would come from a QR scan or from the typed code's companion
 * key field, not implemented at M2).
 *
 * At M2 this route confirms "we found a capture for this code" and
 * shows a placeholder; M3 wires actual rule output.
 */
export default async function SessionPage({ params }: SessionPageProps) {
  const { code: raw } = await params;
  const code = raw.toUpperCase();
  if (!bridgeDisplayCodeSchema.safeParse(code).success) notFound();

  const result = await fetchCapture(code);
  if (!result) notFound();

  return <SessionView code={code} result={result} />;
}

async function fetchCapture(code: string): Promise<CaptureFetchResult | null> {
  const url = relayUrl(`/api/v1/captures/${code}`);
  const res = await fetch(url, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Relay returned ${res.status} fetching capture`);
  }
  const body = (await res.json()) as {
    envelope: unknown;
    caregiver_label: string | null;
  };
  const envelope = bridgeCaptureEnvelopeSchema.parse(body.envelope);
  return { envelope, caregiver_label: body.caregiver_label };
}

function relayUrl(path: string): string {
  const base = process.env.BRIDGE_RELAY_BASE_URL ?? "http://localhost:3002";
  return `${base}${path}`;
}
