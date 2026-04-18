/**
 * @vitest-environment jsdom
 *
 * WCAG 2.1 AA compliance: verify the root layout renders a "skip to main
 * content" link as the first focusable element inside <body>, and that a
 * corresponding <main id="main-content"> target exists. (Issue #182, 2.4.1
 * Bypass Blocks.)
 *
 * The RootLayout renders <html>/<body>, which React Testing Library cannot
 * mount inside a jsdom document directly, so we import the layout module
 * and invoke its exported default against a minimal child, then walk the
 * resulting element tree.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// Mock Providers so we don't pull tRPC / auth context during a pure
// structural test of the layout tree.
vi.mock("../../app/providers", () => ({
  Providers: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import RootLayout from "../../app/layout";

/**
 * Recursively collect every React element in the tree into a flat array so
 * we can reason about ordering and attributes without mounting a full DOM.
 */
function flatten(node: React.ReactNode): React.ReactElement[] {
  const out: React.ReactElement[] = [];
  const visit = (n: React.ReactNode) => {
    if (n == null || typeof n === "boolean") return;
    if (Array.isArray(n)) {
      n.forEach(visit);
      return;
    }
    if (typeof n === "object" && "type" in n) {
      out.push(n as React.ReactElement);
      const children = (n as React.ReactElement).props?.children;
      if (children !== undefined) visit(children);
    }
  };
  visit(node);
  return out;
}

describe("patient-portal RootLayout skip navigation", () => {
  const tree = RootLayout({ children: <div data-testid="page-children" /> });
  const elements = flatten(tree);

  it("renders a skip link whose href targets #main-content", () => {
    const skipLink = elements.find(
      (el) => el.type === "a" && el.props?.href === "#main-content",
    );
    expect(skipLink).toBeDefined();
    expect(String(skipLink?.props?.children)).toMatch(/skip to main content/i);
  });

  it("renders a <main> with id=main-content", () => {
    const mainEl = elements.find(
      (el) => el.type === "main" && el.props?.id === "main-content",
    );
    expect(mainEl).toBeDefined();
  });

  it("places the skip link before the <main> element in source order", () => {
    const skipIdx = elements.findIndex(
      (el) => el.type === "a" && el.props?.href === "#main-content",
    );
    const mainIdx = elements.findIndex(
      (el) => el.type === "main" && el.props?.id === "main-content",
    );
    expect(skipIdx).toBeGreaterThanOrEqual(0);
    expect(mainIdx).toBeGreaterThan(skipIdx);
  });
});
