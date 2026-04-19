import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, within } from "@testing-library/react";
import { EducationCard } from "../components/EducationCard";
import type { EducationContent } from "@carebridge/medical-logic";

afterEach(cleanup);

const sample: EducationContent = {
  title: "High Blood Pressure",
  summary: "Your heart is working harder than it should.",
  self_care: ["Check at home", "Cut salt"],
  when_to_contact_provider: ["BP over 180/120", "Chest pain — call 911"],
  links: [{ label: "CDC", url: "https://www.cdc.gov/bloodpressure" }],
};

describe("EducationCard (#328)", () => {
  it("renders title, summary, self-care items, and when-to-contact items", () => {
    render(<EducationCard content={sample} />);
    expect(screen.getByText("High Blood Pressure")).toBeInTheDocument();
    expect(screen.getByText(/heart is working harder/i)).toBeInTheDocument();
    expect(screen.getByText("Check at home")).toBeInTheDocument();
    expect(screen.getByText("BP over 180/120")).toBeInTheDocument();
  });

  it("renders external learn-more links with target=_blank and noopener", () => {
    const { container } = render(<EducationCard content={sample} />);
    const link = within(container).getByRole("link", { name: "CDC" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
  });

  it("omits the 'Learn more' footer when content has no links", () => {
    const noLinks: EducationContent = { ...sample, links: undefined };
    const { container } = render(<EducationCard content={noLinks} />);
    expect(within(container).queryByText(/learn more/i)).not.toBeInTheDocument();
  });

  it("shows an anchor line when the caller passes a chart reference", () => {
    const { container } = render(
      <EducationCard content={sample} anchor="Essential hypertension" />,
    );
    expect(within(container).getByText(/Essential hypertension/)).toBeInTheDocument();
  });

  it("uses an <article> wrapper for landmark navigation", () => {
    const { container } = render(<EducationCard content={sample} />);
    expect(container.querySelector("article")).not.toBeNull();
  });
});
