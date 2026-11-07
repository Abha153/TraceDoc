import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { Job } from "../../../contracts/types";
import { lineState, pollDelay, jobCoverage } from "../lib/jobs";
import { nextStep } from "../lib/routes";
import { Dock, buildDockTabs } from "./Dock";
import { AnalyzerChecklist, StepProgress } from "./Stepper";

const analyzers: Job["analyzers"] = {
  ocr: { state: "DONE", analyzerStatus: "AVAILABLE" },
  "pdf.textlayer": { state: "NOT_APPLICABLE", analyzerStatus: "NOT_APPLICABLE" },
  "image.ela": { state: "RUNNING" },
  "image.noise": { state: "PENDING" },
  signature: { state: "UNAVAILABLE", analyzerStatus: "UNAVAILABLE", message: "Model not installed." },
  "image.copymove": { state: "ERROR", analyzerStatus: "ERROR", message: "Timed out." },
};

describe("AnalyzerChecklist", () => {
  it("spells out queued, running, available, not applicable, unavailable and error in words", () => {
    render(<AnalyzerChecklist analyzers={analyzers} />);
    const list = screen.getByRole("list", { name: "Analyzer checklist" });
    ["Available", "Not applicable", "Running", "Queued", "Unavailable", "Error"].forEach((label) => expect(within(list).getByText(label)).toBeInTheDocument());
    expect(within(list).getByText("Model not installed.")).toBeInTheDocument();
  });

  it("never counts unavailable, errored or not-applicable analyzers as having run", () => {
    const job = { analyzers } as Job;
    expect(jobCoverage(job)).toEqual({ ran: 1, possible: 5 });
    expect(lineState({ state: "DONE" })).toBe("available");
    expect(lineState({ state: "UNAVAILABLE" })).toBe("unavailable");
  });
});

describe("StepProgress", () => {
  it("marks the current step for assistive technology", () => {
    render(<StepProgress steps={["Upload", "Analyze", "Result"]} current={1} />);
    expect(screen.getByText("Analyze").closest("li")).toHaveAttribute("aria-current", "step");
  });
});

describe("Dock", () => {
  it("keeps tabs with a reason visible and explains why they cannot be used", () => {
    const tabs = buildDockTabs("D-01", { findingCount: 2, tabDisabled: { evidence: "Not applicable: image has no text layer" } });
    render(<MemoryRouter><Dock docId="D-01" tabs={tabs} activeKey="findings" /></MemoryRouter>);
    const dock = screen.getByRole("navigation", { name: "Document sections" });
    expect(within(dock).getByRole("link", { name: /Findings/ })).toHaveAttribute("aria-current", "page");
    const evidence = within(dock).getByRole("link", { name: /Evidence/ });
    expect(evidence).toHaveAttribute("aria-disabled", "true");
    expect(evidence).toHaveAttribute("title", "Not applicable: image has no text layer");
    expect(within(dock).getByRole("link", { name: /next step/i })).toHaveAttribute("href", "/documents/D-01/evidence");
  });

  it("advances one logical step and ends on scanning another document", () => {
    expect(nextStep("D-01", "overview").to).toBe("/documents/D-01/investigation");
    expect(nextStep("D-01", "investigation").to).toBe("/documents/D-01/findings");
    expect(nextStep("D-01", "findings").to).toBe("/documents/D-01/evidence");
    expect(nextStep("D-01", "evidence").to).toBe("/documents/D-01/report");
    expect(nextStep("D-01", "report")).toMatchObject({ label: "Scan another document", to: "/scanner" });
  });

  it("backs off polling up to a ceiling", () => {
    expect(pollDelay(1000, 0)).toBe(1000);
    expect(pollDelay(1000, 3)).toBe(2197);
    expect(pollDelay(1000, 50)).toBe(5000);
  });
});
