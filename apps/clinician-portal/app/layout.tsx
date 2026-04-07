import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Sidebar } from "./sidebar";
import { Providers } from "./providers";

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
              {children}
            </main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
