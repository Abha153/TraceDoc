import { beforeEach, describe, expect, it } from "vitest";
import type { FindingWithReview } from "../../../contracts/api";
import { analyzerCoverage, findingsForDocument, formatBytes, humanize, relativeTime, scoreOutOf100 } from "./format";
import { readLastViewed, writeLastViewed } from "./lastViewed";
import { tabIndex, transitionKey } from "./routes";

describe("format", () => {
  it("counts ran versus possible analyzers and excludes not-applicable ones", () => {
    expect(analyzerCoverage({ ocr: "AVAILABLE", "pdf.fonts": "NOT_APPLICABLE", signature: "UNAVAILABLE", "image.ela": "ERROR" })).toEqual({ ran: 1, possible: 3 });
  });
  it("formats sizes, scores and relative times", () => {
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(scoreOutOf100(0.877)).toBe(88);
    expect(relativeTime("2026-11-06T10:00:00Z", Date.parse("2026-11-06T12:00:00Z"))).toBe("2 h ago");
  });
  it("links findings to a document through evidence regions", () => {
    const base = { caseId: "C", category: "visual", type: "X", observationStatus: "OBSERVED", severity: "low", confidence: 0.5, needsVerification: [] } as const;
    const evidence = (docId: string) => [{ evidenceId: "E", kind: "metadata", description: "", regions: [{ docId, page: 1, bbox: [0, 0, 1, 1] as [number, number, number, number] }], provenance: {} }];
    const findings = [
      { finding: { ...base, findingId: "F1", evidence: evidence("D-01") }, reviewStatus: "UNREVIEWED" },
      { finding: { ...base, findingId: "F2", evidence: evidence("D-02") }, reviewStatus: "UNREVIEWED" },
    ] as unknown as FindingWithReview[];
    expect(findingsForDocument(findings, "D-01").map((item) => item.finding.findingId)).toEqual(["F1"]);
  });
});

describe("routes and last viewed", () => {
  beforeEach(() => localStorage.clear());
  it("keeps document tabs under one transition key and orders them", () => {
    expect(transitionKey("/documents/D-01/findings")).toBe(transitionKey("/documents/D-01/report"));
    expect(transitionKey("/cases")).toBe("/cases");
    expect(tabIndex("/documents/D-01/findings")).toBe(2);
    expect(tabIndex("/cases")).toBeNull();
  });
  it("round-trips and rejects a corrupted last-viewed entry", () => {
    writeLastViewed({ path: "/documents/D-01/overview", label: "id_card.png", docId: "D-01" });
    expect(readLastViewed()?.path).toBe("/documents/D-01/overview");
    localStorage.setItem("tracedocs.lastViewed", "{not json");
    expect(readLastViewed()).toBeNull();
  });
});

import { toHex } from "./format";
describe("toHex", () => {
  it("renders bytes as lowercase hex", () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
  });
});

describe("humanize", () => {
  it("splits camelCase measurement keys and keeps enum and dotted ids readable", () => {
    expect(humanize("ruleType")).toBe("Rule type");
    expect(humanize("entityResolution")).toBe("Entity resolution");
    expect(humanize("POTENTIAL_ANOMALY")).toBe("Potential anomaly");
    expect(humanize("pdf.textlayer")).toBe("Pdf textlayer");
  });
});
