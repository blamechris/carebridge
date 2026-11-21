/**
 * @vitest-environment jsdom
 *
 * WCAG 2.1 AA — 3.3.1 Error Identification.
 *
 * The patient-portal login form's error container must be announced to
 * assistive technology as soon as it appears. That means both
 * `role="alert"` and an explicit `aria-live="assertive"`. The existing
 * markup sets role="alert" but omits aria-live; this test asserts the
 * full contract required by issue #183.
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

describe("patient-portal login error a11y (WCAG 3.3.1)", () => {
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


describe("MFA browser session recovery", () => {
  afterEach(() => {
    cleanup();
    loginMutate.mockReset();
    mfaCompleteMutate.mockReset();
    vi.unstubAllGlobals();
  });

  it.each([false, true])("handles MFA errors when the challenge was consumed: %s", async (consumed) => {
    loginMutate.mockResolvedValueOnce({ requiresMFA: true, mfaSessionId: "challenge-1" });
    if (consumed) {
      mfaCompleteMutate.mockResolvedValueOnce({ user: { id: "user-1" }, session: { id: "session-1" } });
    } else {
      mfaCompleteMutate.mockRejectedValueOnce(new Error("Invalid verification code"));
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: false });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(
      <AuthProvider>
        <LoginPage />
      </AuthProvider>,
    );
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "x@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "example" } });
    fireEvent.submit(container.querySelector("form")!);

    const input = await screen.findByLabelText("Verification Code");
    fireEvent.change(input, { target: { value: "123456" } });
    fireEvent.submit(container.querySelector("form")!);
    const alert = await screen.findByRole("alert");

    expect(mfaCompleteMutate).toHaveBeenCalledWith({ mfaSessionId: "challenge-1", code: "123456" });
    if (consumed) {
      expect(alert.textContent).toMatch(/could not establish a browser session/i);
      expect(screen.queryByLabelText("Verification Code")).toBeNull();
      expect(screen.getByLabelText("Email")).toBeDefined();
    } else {
      expect(alert.textContent).toMatch(/invalid verification code/i);
      expect(screen.getByLabelText("Verification Code")).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });
});
