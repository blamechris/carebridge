export function PostMortemBanner() {
  return (
    <aside
      className="bridge-banner bridge-banner--disclaimer"
      role="note"
      aria-label="Decision support disclaimer"
    >
      <strong>Decision support, not a diagnosis.</strong>
      <p>
        The bridge surfaces cross-specialty patterns from the patient&apos;s
        captured timeline. Every flag links to the source observation.
        Clinical judgment remains with the treating clinician.
      </p>
    </aside>
  );
}
