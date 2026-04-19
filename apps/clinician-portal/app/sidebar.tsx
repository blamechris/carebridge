"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((part) => part[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/**
 * Focus management for the sidebar drawer (WCAG 2.1.2 / 2.4.3 / 2.4.7):
 *   - On open: saves the previously-focused element and moves focus into
 *     the drawer.
 *   - While open: traps Tab / Shift+Tab within focusable descendants and
 *     closes the drawer on Escape.
 *   - On close: restores focus to the element that opened the drawer
 *     (usually the hamburger toggle).
 */
function useSidebarFocusTrap(
  isOpen: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const container = containerRef.current;
    if (!container) return;

    previousFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    );
    const firstFocusable = focusables[0];
    if (firstFocusable) {
      firstFocusable.focus();
    } else {
      container.focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const current = containerRef.current;
      if (!current) return;
      const items = Array.from(
        current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (items.length === 0) {
        event.preventDefault();
        current.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !current.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, containerRef, onClose]);

  useEffect(() => {
    if (isOpen) return;
    const previous = previousFocusRef.current;
    if (previous && typeof previous.focus === "function") {
      previous.focus();
    }
    previousFocusRef.current = null;
  }, [isOpen]);
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, clearSession, isAuthenticated, hydrated } = useAuth();
  const [isOpen, setIsOpen] = useState(false);
  const asideRef = useRef<HTMLElement | null>(null);

  const closeDrawer = () => setIsOpen(false);
  useSidebarFocusTrap(isOpen, asideRef, closeDrawer);

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
          onClick={closeDrawer}
          aria-hidden="true"
        />
      )}

      <aside
        ref={asideRef}
        className={`sidebar ${isOpen ? "sidebar-open" : ""}`}
        aria-label="Primary sidebar"
        tabIndex={-1}
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
          onClick={closeDrawer}
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
