"use client";

import Link from "next/link";
import { AuthGuard } from "@/lib/auth-guard";
import { EpicIntegrationsPanel } from "@/components/epic-integrations-panel";

function IntegrationsContent() {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Integrations</h1>
        <p className="page-subtitle">
          Connect external clinical systems to CareBridge.
        </p>
        <div style={{ marginTop: 6 }}>
          <Link
            href="/settings"
            style={{ fontSize: 12, color: "var(--text-muted)" }}
          >
            &larr; Back to Account Settings
          </Link>
        </div>
      </div>

      <div style={{ maxWidth: 720 }}>
        <EpicIntegrationsPanel />
      </div>
    </>
  );
}

export default function IntegrationsPage() {
  return (
    <AuthGuard>
      <IntegrationsContent />
    </AuthGuard>
  );
}
