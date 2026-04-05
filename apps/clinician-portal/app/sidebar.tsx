"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const navItems = [
  { href: "/", label: "Dashboard", icon: "\u25A3" },
  { href: "/patients", label: "Patients", icon: "\u2302" },
  { href: "/inbox", label: "Inbox (AI Flags)", icon: "\u26A0", badge: 3 },
  { href: "/notes", label: "Notes", icon: "\u270E" },
  { href: "/schedule", label: "Schedule", icon: "\u25F7" },
];

export function Sidebar() {
  const pathname = usePathname();

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
              {item.badge && <span className="nav-badge">{item.badge}</span>}
            </Link>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="provider-info">
          <div className="provider-avatar">SP</div>
          <div>
            <div className="provider-name">Dr. Sarah Patel</div>
            <div className="provider-role">Internal Medicine</div>
          </div>
        </div>
      </div>
    </aside>
  );
}
