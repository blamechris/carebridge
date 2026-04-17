/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { StaleDataBanner } from "@/components/stale-data-banner.js";

describe("StaleDataBanner", () => {
  afterEach(() => {
    cleanup();
  });

  /** Timestamp 10 days in the past. */
  const staleDate = new Date(
    Date.now() - 10 * 24 * 60 * 60 * 1000,
  ).toISOString();

  /** Timestamp 1 hour in the past (current data). */
  const currentDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // ── Accessibility attributes ──────────────────────────────────────

  it('has role="status" (polite live region, not assertive alert)', () => {
    const { container } = render(
      <StaleDataBanner lastRecordedAt={staleDate} label="vitals" />,
    );
    const banner = container.firstElementChild as HTMLElement;
    expect(banner.getAttribute("role")).toBe("status");
  });

  it('sets aria-live="polite" explicitly for AT compatibility', () => {
    const { container } = render(
      <StaleDataBanner lastRecordedAt={staleDate} label="vitals" />,
    );
    const banner = container.firstElementChild as HTMLElement;
    expect(banner.getAttribute("aria-live")).toBe("polite");
  });

  it('does NOT use role="alert" (would preempt screen reader)', () => {
    const { container } = render(
      <StaleDataBanner lastRecordedAt={staleDate} label="vitals" />,
    );
    const banner = container.firstElementChild as HTMLElement;
    expect(banner.getAttribute("role")).not.toBe("alert");
  });

  // ── Content rendering ─────────────────────────────────────────────

  it("renders the label in the stale-data message", () => {
    const { container } = render(
      <StaleDataBanner lastRecordedAt={staleDate} label="labs" />,
    );
    expect(container.textContent).toContain("Stale labs:");
  });

  it("renders the label for vitals", () => {
    const { container } = render(
      <StaleDataBanner lastRecordedAt={staleDate} label="vitals" />,
    );
    expect(container.textContent).toContain("Stale vitals:");
  });

  it("pluralizes days correctly for multi-day staleness", () => {
    const { container } = render(
      <StaleDataBanner lastRecordedAt={staleDate} label="vitals" />,
    );
    expect(container.textContent).toMatch(/10 days ago/);
  });

  it("uses singular 'day' for exactly 1 day old data", () => {
    const oneDayAgo = new Date(
      Date.now() - 1 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { container } = render(
      <StaleDataBanner lastRecordedAt={oneDayAgo} label="vitals" />,
    );
    expect(container.textContent).toMatch(/1 day ago/);
    expect(container.textContent).not.toMatch(/1 days ago/);
  });

  it("includes a warning that values may not reflect current state", () => {
    const { container } = render(
      <StaleDataBanner lastRecordedAt={currentDate} label="vitals" />,
    );
    expect(container.textContent).toContain(
      "Values shown may not reflect the patient",
    );
  });
});
