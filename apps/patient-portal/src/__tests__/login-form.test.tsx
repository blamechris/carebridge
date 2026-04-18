import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// Mock trpc to avoid actual network calls
vi.mock("@/lib/trpc", () => ({
  trpcVanilla: {
    auth: {
      login: { mutate: vi.fn() },
      mfaCompleteLogin: { mutate: vi.fn() },
    },
  },
}));

import { AuthProvider } from "@carebridge/portal-shared/auth";
import LoginPage from "../../app/login/page";

describe("LoginPage rendering", () => {
  afterEach(() => {
    cleanup();
    window.localStorage.removeItem("carebridge_user");
    window.localStorage.removeItem("carebridge_has_session");
  });

  it("renders the sign-in heading", () => {
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    expect(
      screen.getByRole("heading", { name: /sign in to patient portal/i }),
    ).toBeDefined();
  });

  it("renders email and password inputs", () => {
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    expect(screen.getByLabelText("Email")).toBeDefined();
    expect(screen.getByLabelText("Password")).toBeDefined();
  });

  it("renders a sign-in button", () => {
    render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    expect(
      screen.getByRole("button", { name: /sign in/i }),
    ).toBeDefined();
  });
});
