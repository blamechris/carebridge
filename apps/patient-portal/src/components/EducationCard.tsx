"use client";

import type { EducationContent } from "@carebridge/medical-logic";

interface EducationCardProps {
  content: EducationContent;
  /** Optional context (e.g. the patient's diagnosis or medication name as written in the chart). */
  anchor?: string;
}

/**
 * Patient-facing education card (issue #328).
 *
 * Renders a diagnosis or medication's plain-language summary, self-care
 * bullets, and when-to-contact-your-care-team warnings. Mirrors the
 * dark-card visual pattern used elsewhere in the patient portal so it
 * slots into existing pages without a separate design system.
 */
export function EducationCard({ content, anchor }: EducationCardProps) {
  return (
    <article
      style={{
        backgroundColor: "#1a1a1a",
        border: "1px solid #2a2a2a",
        borderRadius: 8,
        padding: "1rem",
        marginBottom: "0.75rem",
      }}
      aria-labelledby={`edu-${content.title.replace(/\s+/g, "-").toLowerCase()}`}
    >
      <header>
        <h4
          id={`edu-${content.title.replace(/\s+/g, "-").toLowerCase()}`}
          style={{ margin: 0, fontSize: "1rem" }}
        >
          {content.title}
        </h4>
        {anchor && (
          <p style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", color: "#888" }}>
            Linked to your record: <em>{anchor}</em>
          </p>
        )}
      </header>

      <p style={{ fontSize: "0.9rem", lineHeight: 1.5, margin: "0.75rem 0" }}>
        {content.summary}
      </p>

      <section aria-label="Self-care tips" style={{ marginTop: "0.75rem" }}>
        <h5 style={{ margin: 0, fontSize: "0.85rem", color: "#bbb" }}>Daily care</h5>
        <ul style={{ margin: "0.25rem 0 0 1rem", paddingLeft: 0, fontSize: "0.85rem" }}>
          {content.self_care.map((item, i) => (
            <li key={i} style={{ marginBottom: 2 }}>
              {item}
            </li>
          ))}
        </ul>
      </section>

      <section
        aria-label="When to contact your care team"
        style={{
          marginTop: "0.75rem",
          backgroundColor: "#2a1a1a",
          border: "1px solid #4a2a2a",
          borderRadius: 6,
          padding: "0.5rem 0.75rem",
        }}
      >
        <h5 style={{ margin: 0, fontSize: "0.85rem", color: "#f87171" }}>
          When to contact your care team
        </h5>
        <ul style={{ margin: "0.25rem 0 0 1rem", paddingLeft: 0, fontSize: "0.85rem" }}>
          {content.when_to_contact_provider.map((item, i) => (
            <li key={i} style={{ marginBottom: 2 }}>
              {item}
            </li>
          ))}
        </ul>
      </section>

      {content.links && content.links.length > 0 && (
        <footer style={{ marginTop: "0.75rem" }}>
          <h5 style={{ margin: 0, fontSize: "0.85rem", color: "#bbb" }}>Learn more</h5>
          <ul style={{ margin: "0.25rem 0 0 1rem", paddingLeft: 0, fontSize: "0.85rem" }}>
            {content.links.map((link, i) => (
              <li key={i}>
                <a
                  href={link.url}
                  rel="noopener noreferrer"
                  target="_blank"
                  style={{ color: "#60a5fa" }}
                >
                  {link.label}
                </a>
              </li>
            ))}
          </ul>
        </footer>
      )}
    </article>
  );
}
