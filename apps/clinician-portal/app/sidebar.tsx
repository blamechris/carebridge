"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpcVanilla } from "@/lib/trpc";

const navItems = [
  { href: "/", label: "Dashboard", icon: "\u25A3" },
  { href: "/patients", label: "Patients", icon: "\u2302" },
  { href: "/inbox", label: "Inbox (AI Flags)", icon: "\u26A0" },
  { href: "/notes", label: "Notes", icon: "\u270E" },
  { href: "/schedule", label: "Schedule", icon: "\u25F7" },
];

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, clearSession, isAuthenticated } = useAuth();

  async function handleLogout() {
    try {
      await trpcVanilla.auth.logout.mutate();
    } catch {
      // Session might already be expired -- that is fine
    }
    clearSession();
    router.push("/login");
  }

  if (!isAuthenticated) return null;

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          Care<span>Bridge</span>
        </div>
        <div className="sidebar-subtitle">Clinician Portal</div>
      </div>

      <nav className="sidebar-nav">
        {navItems.map((item) => {
          const isActive =
            item.href === "/"
              ? pathname === "/"
              : pathname.startsWith(item.href);

          return (
            <Link
              key={item.href}
              href={item.href}
              className={`nav-link ${isActive ? "active" : ""}`}
            >
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="provider-info">
          <div className="provider-avatar">
            {user ? getInitials(user.name) : "?"}
          </div>
          <div>
            <div className="provider-name">{user?.name ?? "Unknown"}</div>
            <div className="provider-role">
              {user?.specialty ?? user?.role ?? ""}
            </div>
          </div>
        </div>
        <button
          onClick={handleLogout}
          className="btn btn-ghost btn-sm"
          style={{ marginTop: 8, width: "100%", textAlign: "center" }}
        >
          Sign Out
        </button>
      </div>
    </aside>
  );
}
