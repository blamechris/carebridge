/**
 * @vitest-environment jsdom
 *
 * Issue #404 — mobile/tablet responsive layout.
 *
 * On viewports narrower than 768px the fixed 240px sidebar is unusable,
 * so we collapse it into a hamburger-triggered drawer. The component-
 * level behaviours this test pins:
 *
 *   1. The sidebar toggle button is always rendered (CSS controls
 *      whether it is visible) and carries an accessible name plus
 *      aria-expanded state.
 *   2. The sidebar aside starts closed (sidebar-open class absent) and
 *      the click-away backdrop is NOT rendered.
 *   3. Clicking the toggle flips the sidebar to open, adds the
 *      `sidebar-open` class, flips aria-expanded to "true", and
 *      renders a backdrop.
 *   4. Clicking a nav item closes the drawer again (sidebar-open is
 *      removed). This matters on phones where the drawer covers the
 *      main content.
 *   5. Clicking the backdrop also closes the drawer.
 *
 * CSS-driven "hamburger hidden on desktop / shown on mobile" is a media
 * query concern that jsdom cannot meaningfully exercise; those rules
 * live in globals.css and are verified via manual QA + visual review.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    user: { id: "u1", name: "Dr. Smith", role: "physician", specialty: "Hem/Onc" },
    isAuthenticated: true,
    hydrated: true,
    clearSession: vi.fn(),
  }),
}));

vi.mock("@/lib/trpc", () => ({
  trpcVanilla: {
    auth: { logout: { mutate: vi.fn().mockResolvedValue(undefined) } },
  },
}));

import { Sidebar } from "../../app/sidebar";

describe("Sidebar mobile toggle (Issue #404)", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the hamburger toggle with an accessible label", () => {
    render(<Sidebar />);
    const toggle = screen.getByRole("button", {
      name: /toggle navigation menu/i,
    });
    expect(toggle).toBeTruthy();
    // The toggle carries the CSS class that media queries target for
    // the "show on <1024px, hide on desktop" behaviour.
    expect(toggle.classList.contains("sidebar-toggle")).toBe(true);
  });

  it("starts closed: aria-expanded=false, sidebar-open class absent, no backdrop", () => {
    const { container } = render(<Sidebar />);
    const toggle = screen.getByRole("button", {
      name: /toggle navigation menu/i,
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    const aside = container.querySelector("aside.sidebar");
    expect(aside).toBeTruthy();
    expect(aside?.classList.contains("sidebar-open")).toBe(false);

    // Backdrop is only rendered when open.
    expect(container.querySelector(".sidebar-backdrop")).toBeNull();
  });

  it("opens the drawer when the hamburger is clicked", () => {
    const { container } = render(<Sidebar />);
    const toggle = screen.getByRole("button", {
      name: /toggle navigation menu/i,
    });

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const aside = container.querySelector("aside.sidebar");
    expect(aside?.classList.contains("sidebar-open")).toBe(true);
    // Backdrop present so taps outside the drawer can dismiss it.
    expect(container.querySelector(".sidebar-backdrop")).not.toBeNull();
  });

  it("closes the drawer when a nav link is clicked", () => {
    const { container } = render(<Sidebar />);
    const toggle = screen.getByRole("button", {
      name: /toggle navigation menu/i,
    });
    fireEvent.click(toggle);

    // Sanity: open.
    expect(
      container.querySelector("aside.sidebar")?.classList.contains("sidebar-open"),
    ).toBe(true);

    // Click a nav link (bubbles to the <nav onClick> handler).
    const patientsLink = screen.getByRole("link", { name: /patients/i });
    fireEvent.click(patientsLink);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(
      container.querySelector("aside.sidebar")?.classList.contains("sidebar-open"),
    ).toBe(false);
    expect(container.querySelector(".sidebar-backdrop")).toBeNull();
  });

  it("closes the drawer when the backdrop is clicked", () => {
    const { container } = render(<Sidebar />);
    fireEvent.click(
      screen.getByRole("button", { name: /toggle navigation menu/i }),
    );

    const backdrop = container.querySelector(".sidebar-backdrop");
    expect(backdrop).not.toBeNull();

    fireEvent.click(backdrop as Element);

    expect(
      container.querySelector("aside.sidebar")?.classList.contains("sidebar-open"),
    ).toBe(false);
    expect(container.querySelector(".sidebar-backdrop")).toBeNull();
  });

  it("toggle icon switches between hamburger and close glyph", () => {
    render(<Sidebar />);
    const toggle = screen.getByRole("button", {
      name: /toggle navigation menu/i,
    });
    const iconSpan = toggle.querySelector(".sidebar-toggle-icon");
    expect(iconSpan?.textContent).toBe("\u2630"); // ☰ hamburger

    fireEvent.click(toggle);
    expect(iconSpan?.textContent).toBe("\u2715"); // ✕ close
  });
});
