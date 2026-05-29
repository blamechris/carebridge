import Link from "next/link";
import type { BridgeCaptureEnvelope } from "@carebridge/shared-types";
import { PostMortemBanner } from "../../components/PostMortemBanner";

interface SessionViewProps {
  code: string;
  result: {
    envelope: BridgeCaptureEnvelope;
    caregiver_label: string | null;
  };
}

/**
 * M2 placeholder view. Confirms the relay handed us an envelope for
 * the given display code. M3 will decrypt the envelope (using the
 * key from a QR scan or typed in alongside the code) and render the
 * decoded FHIR bundle through the rule engine.
 */
export function SessionView({ code, result }: SessionViewProps) {
  const { envelope, caregiver_label } = result;

  return (
    <main className="bridge-landing">
      <header className="bridge-landing__header">
        <h1>Capture {code}</h1>
        <p className="bridge-landing__tagline">
          {caregiver_label ?? "Paired MedLens capture"}
        </p>
      </header>

      <PostMortemBanner />

      <section className="bridge-landing__pair-cta">
        <h2>Capture received</h2>
        <dl className="bridge-capture-meta">
          <dt>Capture ID</dt>
          <dd><code>{envelope.capture_id}</code></dd>
          <dt>Uploaded</dt>
          <dd>{envelope.uploaded_at}</dd>
          <dt>Expires</dt>
          <dd>{envelope.expires_at}</dd>
          <dt>Ciphertext size</dt>
          <dd>{envelope.ciphertext.length} bytes (base64url)</dd>
        </dl>
        <p className="bridge-landing__milestone-note">
          M3 will decrypt this envelope and render rule output. At M2 we
          confirm the relay round-trip works end-to-end.
        </p>
      </section>

      <footer className="bridge-landing__footer">
        <Link href="/">← New session</Link>
      </footer>
    </main>
  );
}
