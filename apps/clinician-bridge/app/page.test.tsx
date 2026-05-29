import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import LandingPage from "./page";

describe("LandingPage", () => {
  it("renders the bridge title", () => {
    render(<LandingPage />);
    expect(
      screen.getByRole("heading", { name: /clinician bridge/i, level: 1 }),
    ).toBeDefined();
  });

  it("shows the not-a-diagnosis disclaimer", () => {
    render(<LandingPage />);
    expect(
      screen.getByText(/decision support, not a diagnosis/i),
    ).toBeDefined();
  });

  it("explains the no-persistence safety posture", () => {
    render(<LandingPage />);
    expect(
      screen.getByText(/does not store patient data/i),
    ).toBeDefined();
  });

  it("points the clinician at the pair flow", () => {
    render(<LandingPage />);
    expect(
      screen.getByRole("heading", { name: /pair a medlens capture/i }),
    ).toBeDefined();
  });
});
