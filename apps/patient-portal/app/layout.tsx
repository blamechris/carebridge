import type { Metadata } from "next";
// Shared design tokens (accent, focus-visible, .sr-only, .skip-to-main)
// must load before globals.css so portal-specific overrides win cascade.
import "@carebridge/ui-tokens/tokens.css";
import "./globals.css";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "CareBridge — Patient Portal",
  description: "View your health records and communicate with your care team",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body style={{
        backgroundColor: "#0a0a0a",
        color: "#ededed",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        margin: 0,
        padding: "2rem",
      }}>
        <Providers>
          {/* WCAG 2.1 AA §2.4.1 Bypass Blocks: the skip link must be the
              first focusable element so keyboard users can jump past the
              header straight to the page's main content. It is visually
              hidden until it receives keyboard focus (see globals.css). */}
          <a href="#main-content" className="skip-to-main">
            Skip to main content
          </a>
          <header style={{ borderBottom: "1px solid #2a2a2a", paddingBottom: "1rem", marginBottom: "2rem" }}>
            <h1 style={{ margin: 0, fontSize: "1.5rem" }}>CareBridge</h1>
            <p style={{ margin: "0.25rem 0 0", color: "#999", fontSize: "0.875rem" }}>Patient Portal</p>
          </header>
          <main id="main-content" tabIndex={-1}>
            {children}
          </main>
        </Providers>
      </body>
    </html>
  );
}
