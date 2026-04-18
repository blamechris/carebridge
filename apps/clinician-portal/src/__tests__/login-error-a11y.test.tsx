/**
 * @vitest-environment jsdom
 *
 * WCAG 2.1 AA — 3.3.1 Error Identification.
 *
 * When the clinician-portal login form reports an error (failed
 * credentials, failed MFA verification), the error container must be
 * announced to assistive technology immediately. That requires both
 * `role="alert"` and an explicit `aria-live="assertive"`.
 *
 * We stub the tRPC client so the submit handler rejects synchronously,
 * then wait for the error element to render and assert its ARIA
 * attributes. Issue #183.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  cleanup,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// Mock the trpc client so we can make login.mutate reject on demand.
const loginMutate = vi.fn();
const mfaCompleteMutate = vi.fn();
vi.mock("@/lib/trpc", () => ({
  trpcVanilla: {
    auth: {
      login: { mutate: (args: unknown) => loginMutate(args) },
      mfaCompleteLogin: { mutate: (args: unknown) => mfaCompleteMutate(args) },
    },
  },
}));

import { AuthProvider } from "@carebridge/portal-shared/auth";
import LoginPage from "../../app/login/page";

describe("clinician-portal login error a11y (WCAG 3.3.1)", () => {
  afterEach(() => {
    cleanup();
    loginMutate.mockReset();
    mfaCompleteMutate.mockReset();
    window.localStorage.removeItem("carebridge_user");
    window.localStorage.removeItem("carebridge_has_session");
  });

  it("announces credential errors with role=alert and aria-live=assertive", async () => {
    loginMutate.mockRejectedValueOnce(new Error("Invalid email or password"));

    const { container } = render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );

    // Fill required inputs so the form is allowed to submit in jsdom, then
    // submit the <form> directly (avoids HTMLFormElement.requestSubmit which
    // jsdom does not fully implement).
    const emailInput = screen.getByLabelText("Email") as HTMLInputElement;
    const passwordInput = screen.getByLabelText("Password") as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "x@example.com" } });
    fireEvent.change(passwordInput, { target: { value: "nope" } });
    const form = container.querySelector("form") as HTMLFormElement;
    fireEvent.submit(form);

    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert.getAttribute("role")).toBe("alert");
    expect(alert.getAttribute("aria-live")).toBe("assertive");
    expect(alert.textContent).toMatch(/invalid email or password/i);
  });
});
