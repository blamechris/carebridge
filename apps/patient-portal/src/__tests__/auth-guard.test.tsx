import React from "react";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// Mock next/navigation before importing components that use it.
const mockReplace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace, push: vi.fn(), back: vi.fn() }),
}));

import { AuthGuard } from "@carebridge/portal-shared/auth-guard";
import { AuthProvider } from "@carebridge/portal-shared/auth";

describe("AuthGuard redirect", () => {
  beforeEach(() => {
    mockReplace.mockClear();
    window.localStorage.removeItem("carebridge_user");
    window.localStorage.removeItem("carebridge_has_session");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem("carebridge_user");
    window.localStorage.removeItem("carebridge_has_session");
  });

  it("redirects unauthenticated users to /login", async () => {
    render(
      <AuthProvider>
        <AuthGuard>
          <div>Protected content</div>
        </AuthGuard>
      </AuthProvider>,
    );

    // After hydration with no stored session, AuthGuard should redirect.
    // The component shows "Redirecting to login..." text when hydrated but
    // not authenticated.
    expect(await screen.findByText("Redirecting to login...")).toBeDefined();
    expect(mockReplace).toHaveBeenCalledWith("/login");
  });

  it("does not render protected content when unauthenticated", () => {
    render(
      <AuthProvider>
        <AuthGuard>
          <div>Protected content</div>
        </AuthGuard>
      </AuthProvider>,
    );

    expect(screen.queryByText("Protected content")).toBeNull();
  });
});
