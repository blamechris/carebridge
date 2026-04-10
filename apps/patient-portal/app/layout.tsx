import type { Metadata } from "next";
import { Providers } from "./providers";
import { PatientNav } from "./patient-nav";

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
          <header style={{ borderBottom: "1px solid #2a2a2a", paddingBottom: "1rem", marginBottom: "2rem" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <h1 style={{ margin: 0, fontSize: "1.5rem" }}>CareBridge</h1>
                <p style={{ margin: "0.25rem 0 0", color: "#999", fontSize: "0.875rem" }}>Patient Portal</p>
              </div>
              <PatientNav />
            </div>
          </header>
          {children}
        </Providers>
      </body>
    </html>
  );
}
