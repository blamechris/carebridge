import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
// Shared design tokens (accent, focus-visible, .sr-only, .skip-to-main)
// must load before globals.css so portal-specific overrides win cascade.
import "@carebridge/ui-tokens/tokens.css";
import "./globals.css";
import { Sidebar } from "./sidebar";
import { Providers } from "./providers";
import { EpicLaunchBanner } from "@/components/epic-launch-banner";

export const metadata: Metadata = {
  title: "CareBridge | Clinician Portal",
  description: "CareBridge clinician-facing healthcare platform",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <Providers>
          <a href="#main-content" className="skip-to-main">
            Skip to main content
          </a>
          <div className="app-layout">
            <Sidebar />
            <main
              id="main-content"
              className="main-content"
              tabIndex={-1}
              role="main"
            >
              {/* Epic launch-context banner (#1182) — only renders when
                  arriving from the SMART App Launch callback with patient
                  context in the URL. Wrapped in Suspense because
                  useSearchParams() requires a boundary in Next 15. */}
              <Suspense fallback={null}>
                <EpicLaunchBanner />
              </Suspense>
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
