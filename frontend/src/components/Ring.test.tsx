import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Gauge, bandTone } from "./Ring";
import { Chip, StatCard } from "./Primitives";

describe("Gauge", () => {
  it("reports priority as a score out of 100 with the band word, not as a probability", () => {
    render(<Gauge score={0.877} band="critical" />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Investigation priority: Critical, score 88 out of 100");
    expect(screen.getByText("Critical")).toBeInTheDocument();
  });

  it("shows a pending state instead of a number when no result exists", () => {
    render(<Gauge score={null} />);
    expect(screen.getByRole("img")).toHaveAccessibleName("Investigation priority: not yet available");
    expect(screen.getByText("Pending")).toBeInTheDocument();
  });

  it("maps bands to tones without merging them with confidence or coverage", () => {
    expect(bandTone("critical")).toBe("red");
    expect(bandTone("moderate")).toBe("amber");
    expect(bandTone("low")).toBe("green");
  });
});

describe("primitives", () => {
  it("renders a chip with a text label so colour is never the only signal", () => {
    render(<Chip tone="amber">Needs verification</Chip>);
    expect(screen.getByText("Needs verification")).toHaveClass("chip-amber");
  });

  it("renders a stat card label and value", () => {
    render(<StatCard label="Open findings" value={6} />);
    expect(screen.getByText("Open findings")).toBeInTheDocument();
    expect(screen.getByText("6")).toBeInTheDocument();
  });
});
