import type { AnalyzerStatus, PriorityBand } from "../../../contracts/types";
import type { FindingWithReview } from "../../../contracts/api";

/** Every analyzer the pipeline can run, in display order (contracts/types.ts AnalyzerProgress keys). */
export const ANALYZER_IDS = ["ocr", "pdf.textlayer", "pdf.fonts", "image.ela", "image.noise", "image.copymove", "signature"] as const;

export const bandLabel: Record<PriorityBand, string> = { low: "Low", moderate: "Moderate", high: "High", critical: "Critical" };

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Priority score is 0..1 in the contract; the UI shows it out of 100. It is an investigation priority, not a probability. */
export function scoreOutOf100(score: number): number {
  return Math.round(Math.min(1, Math.max(0, score)) * 100);
}

export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(then).toISOString().slice(0, 10);
}

/** "Ran" = AVAILABLE. "Possible" = every analyzer that is not NOT_APPLICABLE (UNAVAILABLE and ERROR were possible but did not run). */
export function analyzerCoverage(processing: Record<string, AnalyzerStatus>): { ran: number; possible: number } {
  const statuses = Object.values(processing);
  return {
    ran: statuses.filter((status) => status === "AVAILABLE").length,
    possible: statuses.filter((status) => status !== "NOT_APPLICABLE").length,
  };
}

/** Findings whose evidence regions reference the document (Evidence.regions[].docId in contracts/types.ts). */
export function findingsForDocument(findings: FindingWithReview[], docId: string): FindingWithReview[] {
  return findings.filter(({ finding }) => finding.evidence.some((evidence) => evidence.regions.some((region) => region.docId === docId)));
}

const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3 } as const;
export function severityRank(severity: keyof typeof SEVERITY_RANK): number {
  return SEVERITY_RANK[severity];
}

export function humanize(value: string): string {
  const text = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll(".", " ").toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Product wording: an observation is "Observed"; a forensic hint is a "Potential anomaly (needs verification)". Never a verdict. */
export function observationLabel(status: "OBSERVED" | "INCONSISTENT" | "POTENTIAL_ANOMALY" | "INCONCLUSIVE"): string {
  switch (status) {
    case "POTENTIAL_ANOMALY": return "Potential anomaly (needs verification)";
    case "INCONCLUSIVE": return "Inconclusive";
    default: return "Observed";
  }
}

export const DOC_TYPE_LABEL: Record<string, string> = {
  id_card: "ID card",
  application_form: "Application form",
  bank_statement: "Bank statement",
  other: "Other",
  UNKNOWN: "Unknown",
  AMBIGUOUS: "Ambiguous",
};

/** Hex string of a digest; separated so it can be unit tested without a browser crypto implementation. */
export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
