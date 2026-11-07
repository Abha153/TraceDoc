import type { AnalyzerProgress, Job, JobStatus } from "../../../contracts/types";
import { ANALYZER_IDS } from "./format";

export const TERMINAL_JOB_STATUSES: JobStatus[] = ["DONE", "PARTIAL", "FAILED"];
export const isTerminal = (status: JobStatus | undefined): boolean => status !== undefined && TERMINAL_JOB_STATUSES.includes(status);

/** Poll delay that backs off from the configured interval to a ceiling, so a slow backend is not hammered. */
export function pollDelay(baseMs: number, updates: number): number {
  return Math.min(Math.round(baseMs * Math.pow(1.3, Math.min(updates, 8))), 5000);
}

export type LineState = "queued" | "running" | "available" | "not-applicable" | "unavailable" | "error";

/** One plain-language state per analyzer line. AVAILABLE means the analyzer ran; UNAVAILABLE and ERROR never read as clean. */
export function lineState(progress: AnalyzerProgress | undefined): LineState {
  if (!progress) return "queued";
  if (progress.state === "PENDING") return "queued";
  if (progress.state === "RUNNING") return "running";
  const status = progress.analyzerStatus ?? (progress.state === "DONE" ? "AVAILABLE" : progress.state);
  if (status === "AVAILABLE") return "available";
  if (status === "NOT_APPLICABLE") return "not-applicable";
  if (status === "ERROR") return "error";
  return "unavailable";
}

export const LINE_LABEL: Record<LineState, string> = {
  queued: "Queued",
  running: "Running",
  available: "Available",
  "not-applicable": "Not applicable",
  unavailable: "Unavailable",
  error: "Error",
};

export function orderedAnalyzers(analyzers: Job["analyzers"]): Array<[string, AnalyzerProgress]> {
  const rank = (name: string) => { const index = (ANALYZER_IDS as readonly string[]).indexOf(name); return index < 0 ? 99 : index; };
  return Object.entries(analyzers).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}

export function settledCount(job: Job): { settled: number; total: number } {
  const entries = Object.values(job.analyzers);
  return { settled: isTerminal(job.status) ? entries.length : entries.filter((entry) => lineState(entry) !== "queued" && lineState(entry) !== "running").length, total: entries.length };
}

/** Ran versus possible from the job's own analyzer report (NOT_APPLICABLE is not possible, UNAVAILABLE and ERROR are possible but did not run). */
export function jobCoverage(job: Job): { ran: number; possible: number } {
  const states = Object.values(job.analyzers).map(lineState);
  return { ran: states.filter((state) => state === "available").length, possible: states.filter((state) => state !== "not-applicable").length };
}
