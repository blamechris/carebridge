import type { Metadata, Viewport } from "next";
import "@carebridge/ui-tokens/tokens.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "CareBridge | Clinician Bridge",
  description:
    "Bedside patient context from MedLens captures — surfaces cross-specialty deterioration patterns. Not a diagnosis tool.",
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
      <body className="bridge-body">{children}</body>
    </html>
  );
}
