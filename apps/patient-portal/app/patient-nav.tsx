"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth";

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/checkins", label: "Check-Ins" },
  { href: "/family", label: "Family Access" },
];

export function PatientNav() {
  const pathname = usePathname();
  const { isAuthenticated } = useAuth();

  if (!isAuthenticated) return null;

  return (
    <nav style={{ display: "flex", gap: 4 }}>
      {navItems.map((item) => {
        const isActive =
          item.href === "/"
            ? pathname === "/"
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.href}
            href={item.href}
            style={{
              padding: "6px 14px",
              borderRadius: "6px",
              fontSize: "0.8rem",
              textDecoration: "none",
              color: isActive ? "#93c5fd" : "#999",
              backgroundColor: isActive ? "#1e3a5f" : "transparent",
              border: isActive ? "1px solid #3b82f6" : "1px solid transparent",
              transition: "all 0.15s",
            }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
