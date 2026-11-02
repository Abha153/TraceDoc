import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "./ui";

describe("StatusBadge", () => {
  it("renders all contract status variants with an explicit visual class", () => {
    const statuses = [
      "OBSERVED", "INCONSISTENT", "POTENTIAL_ANOMALY", "INCONCLUSIVE",
      "UNREVIEWED", "CONFIRMED", "DISMISSED",
      "AVAILABLE", "UNAVAILABLE", "ERROR", "NOT_APPLICABLE",
      "low", "moderate", "high", "critical", "info", "medium",
      "QUEUED", "RUNNING", "PARTIAL", "DONE", "FAILED",
      "RESOLVED", "SUGGESTED", "UNRESOLVED",
    ] as const;
    render(<>{statuses.map((status) => <StatusBadge key={status} status={status} />)}</>);

    for (const status of statuses) {
      const badge = screen.getByText(status.replaceAll("_", " "));
      expect(badge).toHaveAttribute("data-status", status);
      expect(badge.className).toMatch(/badge-(blue|amber|violet|gray|emerald|slate|red)/);
    }
  });
});
