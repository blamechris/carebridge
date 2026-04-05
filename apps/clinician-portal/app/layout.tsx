import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "./sidebar";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: "CareBridge | Clinician Portal",
  description: "CareBridge clinician-facing healthcare platform",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
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
