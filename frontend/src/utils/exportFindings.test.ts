import { describe, expect, it } from "vitest";
import type { FindingWithReview } from "../../../contracts/api";
import { collectFindings, csvCell, findingsToCsv, resultsToJson, type ExportDocument } from "./exportFindings";

function finding(id: string, overrides: Partial<FindingWithReview["finding"]> = {}): FindingWithReview {
  return {
    reviewStatus: "UNREVIEWED",
    finding: { findingId: id, caseId: "CASE-001", category: "cross_document", type: "DOB_CONFLICT", observationStatus: "INCONSISTENT", severity: "high", confidence: 0.914, evidence: [], needsVerification: ["Check the original"], explanation: { findingId: id, summary: 'dob differs, "quoted"', observations: [], possibleExplanations: [], recommendedReview: [], evidenceIds: [] }, ...overrides },
  };
}
const doc = (docId: string, filename: string, findings: FindingWithReview[]): ExportDocument => ({ docId, caseId: "CASE-001", caseTitle: "Loan application", filename, status: "DONE", analyzersRan: 5, analyzersPossible: 5, findings });

describe("exportFindings", () => {
  it("lists a finding that spans two documents once, naming both", () => {
    const shared = finding("F-1");
    const out = collectFindings([doc("D-01", "a.png", [shared]), doc("D-02", "b.pdf", [shared, finding("F-2")])]);
    expect(out.map((item) => item.item.finding.findingId)).toEqual(["F-1", "F-2"]);
    expect(out[0].filenames).toEqual(["a.png", "b.pdf"]);
  });

  it("writes a header, escapes quotes and rounds confidence", () => {
    const csv = findingsToCsv([doc("D-01", "a.png", [finding("F-1")])]);
    const lines = csv.replace("﻿", "").trim().split("\r\n");
    expect(lines[0]).toContain("finding_id,category");
    expect(lines[1]).toContain('"dob differs, ""quoted"""');
    expect(lines[1]).toContain(",91,");
  });

  it("neutralises spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("plain")).toBe("plain");
  });

  it("exports an empty document set as a header-only CSV and valid JSON", () => {
    expect(findingsToCsv([]).trim().split("\r\n")).toHaveLength(1);
    expect(JSON.parse(resultsToJson([], "live", "2026-01-01T00:00:00Z")).findings).toEqual([]);
  });

  it("marks fixture exports as synthetic", () => {
    expect(JSON.parse(resultsToJson([doc("D-01", "a.png", [])], "fixture")).note).toMatch(/synthetic/);
  });
});
