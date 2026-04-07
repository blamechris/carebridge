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
          <div className="app-layout">
            <Sidebar />
            <main className="main-content">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
