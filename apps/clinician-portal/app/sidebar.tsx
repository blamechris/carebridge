"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { trpcVanilla } from "@/lib/trpc";

const navItems = [
  { href: "/", label: "Dashboard", icon: "\u25A3" },
  { href: "/patients", label: "Patients", icon: "\u2302" },
  { href: "/inbox", label: "Inbox (AI Flags)", icon: "\u26A0" },
  { href: "/messages", label: "Messages", icon: "\u2709" },
  { href: "/notes", label: "Notes", icon: "\u270E" },
  { href: "/schedule", label: "Schedule", icon: "\u25F7" },
  { href: "/settings", label: "Settings", icon: "\u2699" },
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
  const { user, clearSession, isAuthenticated, hydrated } = useAuth();
  const [isOpen, setIsOpen] = useState(false);

  async function handleLogout() {
    try {
      await trpcVanilla.auth.logout.mutate();
    } catch {
      // Session might already be expired -- that is fine
    }
    clearSession();
    router.push("/login");
  }

  if (!isAuthenticated || !hydrated) return null;

  return (
    <>
      <button
        type="button"
        className="sidebar-toggle"
        aria-label="Toggle navigation menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="sidebar-toggle-icon" aria-hidden="true">
          {isOpen ? "\u2715" : "\u2630"}
        </span>
        <span className="sidebar-toggle-label">
          Care<span>Bridge</span>
        </span>
      </button>

      {isOpen && (
        <div
          className="sidebar-backdrop"
          onClick={() => setIsOpen(false)}
          aria-hidden="true"
        />
      )}

      <aside
        className={`sidebar ${isOpen ? "sidebar-open" : ""}`}
        aria-label="Primary sidebar"
      >
        <div className="sidebar-header">
          <div className="sidebar-logo">
            Care<span>Bridge</span>
          </div>
          <div className="sidebar-subtitle">Clinician Portal</div>
        </div>

        <nav
          className="sidebar-nav"
          aria-label="Primary navigation"
          onClick={() => setIsOpen(false)}
        >
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
                aria-label={item.label}
                aria-current={isActive ? "page" : undefined}
              >
                <span className="nav-icon" aria-hidden="true">
                  {item.icon}
                </span>
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
    </>
  );
}
