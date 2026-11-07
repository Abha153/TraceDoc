import type { FindingWithReview } from "../../../contracts/api";
import { observationLabel } from "../lib/format";
import { downloadBlob } from "./exportPdf";

/** One analysed document plus the findings that reference it. Findings are case-wide, so one finding can appear under several documents. */
export interface ExportDocument {
  docId: string;
  caseId: string;
  caseTitle: string;
  filename: string;
  status: string;
  analyzersRan: number;
  analyzersPossible: number;
  findings: FindingWithReview[];
}

export interface ExportedFinding {
  item: FindingWithReview;
  caseTitle: string;
  filenames: string[];
}

/** Each finding once, with every document it references, ordered by case then finding id. */
export function collectFindings(docs: ExportDocument[]): ExportedFinding[] {
  const byId = new Map<string, ExportedFinding>();
  for (const doc of docs) {
    for (const item of doc.findings) {
      const existing = byId.get(item.finding.findingId);
      if (existing) {
        if (!existing.filenames.includes(doc.filename)) existing.filenames.push(doc.filename);
      } else {
        byId.set(item.finding.findingId, { item, caseTitle: doc.caseTitle, filenames: [doc.filename] });
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.item.finding.caseId.localeCompare(b.item.finding.caseId) || a.item.finding.findingId.localeCompare(b.item.finding.findingId));
}

/** Quote for CSV and neutralise cells a spreadsheet would run as a formula. */
export function csvCell(value: string | number): string {
  let text = String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const COLUMNS = ["case_id", "case_title", "documents", "finding_id", "category", "type", "observation", "severity", "confidence_percent", "review_status", "summary", "needs_verification", "evidence_count"];

export function findingsToCsv(docs: ExportDocument[]): string {
  const rows = collectFindings(docs).map(({ item, caseTitle, filenames }) => {
    const { finding } = item;
    return [
      finding.caseId, caseTitle, filenames.join("; "), finding.findingId, finding.category, finding.type, observationLabel(finding.observationStatus), finding.severity,
      Math.round(finding.confidence * 100), item.reviewStatus, finding.explanation?.summary ?? "", finding.needsVerification.join("; "), finding.evidence.length,
    ].map(csvCell).join(",");
  });
  return `﻿${[COLUMNS.join(","), ...rows].join("\r\n")}\r\n`;
}

export function resultsToJson(docs: ExportDocument[], mode: "fixture" | "live", exportedAt = new Date().toISOString()): string {
  return JSON.stringify({
    exportedAt,
    mode,
    note: mode === "fixture" ? "Fixture mode: outputs are recorded and synthetic, not live processing. Observations are not verdicts." : "Observations are not verdicts. Review status is the analyst's recorded decision.",
    documents: docs.map(({ findings, ...doc }) => ({ ...doc, findingIds: findings.map((item) => item.finding.findingId) })),
    findings: collectFindings(docs).map(({ item, filenames }) => ({ ...item, documents: filenames })),
  }, null, 2);
}

function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

export function downloadFindingsCsv(docs: ExportDocument[], name: string) {
  downloadBlob(new Blob([findingsToCsv(docs)], { type: "text/csv;charset=utf-8" }), `${name}-findings-${stamp()}.csv`);
}

export function downloadResultsJson(docs: ExportDocument[], mode: "fixture" | "live", name: string) {
  downloadBlob(new Blob([resultsToJson(docs, mode)], { type: "application/json" }), `${name}-results-${stamp()}.json`);
}
