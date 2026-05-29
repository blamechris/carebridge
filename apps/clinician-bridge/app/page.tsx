import { PostMortemBanner } from "./components/PostMortemBanner";
import { PairCodeForm } from "./components/PairCodeForm";

export default function LandingPage() {
  return (
    <main className="bridge-landing">
      <header className="bridge-landing__header">
        <h1>CareBridge Clinician Bridge</h1>
        <p className="bridge-landing__tagline">
          Bedside patient context from a MedLens capture.
        </p>
      </header>

      <PostMortemBanner />

      <section className="bridge-landing__pair-cta" aria-labelledby="pair-heading">
        <h2 id="pair-heading">Pair a MedLens capture</h2>
        <p>
          Ask the patient or family caregiver to open MedLens and tap
          <strong> Share with clinician</strong>. They will show you a 6-character
          code or a QR. Enter the code here:
        </p>
        <PairCodeForm />
        <p className="bridge-landing__milestone-note">
          QR scanning ships in a follow-up. M2 supports typed-code entry.
        </p>
      </section>

      <footer className="bridge-landing__footer">
        <p>
          This bridge does not store patient data. Closing this tab erases
          everything on this device. See{" "}
          <a href="https://github.com/blamechris/carebridge/blob/main/docs/clinician-bridge-mvp.md">
            scope doc
          </a>{" "}
          for the safety posture.
        </p>
      </footer>
    </main>
  );
}
