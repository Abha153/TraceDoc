/**
 * B7: priority engine. Pure, deterministic, never mutates its input.
 *
 * Produces an INVESTIGATION PRIORITY, never a fraud probability. It says how much attention a case or document deserves,
 * given the findings that were produced; it says nothing about intent.
 *
 * Per finding: term = severityWeight * confidence (severity and confidence stay separate inputs).
 * Per category: noisy-OR of the terms. A category whose findings are all info/low is capped at weakEvidenceCap (moderate band).
 * Across categories: noisy-OR of categoryWeight * categoryScore. If no finding is medium or high, the final score is capped at
 * weakEvidenceCap as well, so many weak signals can never reach the high bands.
 * Coverage = AVAILABLE / (AVAILABLE + UNAVAILABLE + ERROR) analyzers (NOT_APPLICABLE excluded). It is reported next to the
 * score and never changes it: a missing analyzer contributes nothing, lowers coverage, and does not lower the band.
 * Confidence = severity-weighted mean of the contributing findings' confidences (0 when there are none).
 * Per document: the findings whose evidence touches that document. Per case: all findings.
 */
import type { AnalyzerStatus, Finding, PriorityBand, PriorityOutput, PriorityResult, Provenance, Severity } from "../../../contracts/types";
import engineConfig from "../../config/engine.json";
import { ANALYZER_VERSION, DEFAULT_PROCESSED_AT, inputDigest, roundTo } from "./ruleSupport";

export interface PriorityConfig {
  severityWeights: Readonly<Record<Severity, number>>;
  categoryWeights: Readonly<Record<Finding["category"], number>>;
  bands: { lowBelow: number; moderateBelow: number; highBelow: number };
  weakEvidenceCap: number;
}
export const DEFAULT_PRIORITY_CONFIG: PriorityConfig = engineConfig.priority as PriorityConfig;

export interface PriorityInput {
  findings: readonly Finding[];
  /** docId -> analyzer -> status, for every document of the case (documents without findings still get a result). */
  analyzerStatuses: Readonly<Record<string, Readonly<Record<string, AnalyzerStatus>>>>;
}
export interface PriorityOptions {
  config?: PriorityConfig;
  docSha256?: Readonly<Record<string, string>>;
  processedAt?: string;
}

export function bandOf(score: number, bands: PriorityConfig["bands"]): PriorityBand {
  if (score < bands.lowBelow) return "low";
  if (score < bands.moderateBelow) return "moderate";
  if (score < bands.highBelow) return "high";
  return "critical";
}

function resultFor(findings: readonly Finding[], statuses: readonly AnalyzerStatus[], cfg: PriorityConfig): PriorityResult {
  const byCategory = new Map<Finding["category"], Finding[]>();
  for (const f of findings) byCategory.set(f.category, [...(byCategory.get(f.category) ?? []), f]);
  let combined = 1;
  for (const [category, fs] of byCategory) {
    let notHit = 1;
    for (const f of fs) notHit *= 1 - cfg.severityWeights[f.severity] * f.confidence;
    let score = 1 - notHit;
    if (fs.every((f) => f.severity === "info" || f.severity === "low")) score = Math.min(score, cfg.weakEvidenceCap);
    combined *= 1 - (cfg.categoryWeights[category] ?? 0) * score;
  }
  let score = findings.length ? 1 - combined : 0;
  if (findings.every((f) => f.severity === "info" || f.severity === "low")) score = Math.min(score, cfg.weakEvidenceCap);
  score = roundTo(score, 3);
  const weight = findings.reduce((s, f) => s + cfg.severityWeights[f.severity], 0);
  const confidence = findings.length ? roundTo(findings.reduce((s, f) => s + cfg.severityWeights[f.severity] * f.confidence, 0) / weight, 2) : 0;
  const ran = statuses.filter((s) => s === "AVAILABLE").length;
  const expected = statuses.filter((s) => s === "AVAILABLE" || s === "UNAVAILABLE" || s === "ERROR").length;
  return {
    priorityBand: bandOf(score, cfg.bands), score, confidence, coverage: expected ? roundTo(ran / expected, 3) : 0,
    contributingFindingIds: findings.map((f) => f.findingId),
  };
}

const findingDocs = (f: Finding): Set<string> => new Set(f.evidence.flatMap((e) => e.regions.map((r) => r.docId)));

export function configEcho(cfg: PriorityConfig): Record<string, number> {
  return {
    ...Object.fromEntries(Object.entries(cfg.severityWeights).map(([k, v]) => [`severityWeight_${k}`, v])),
    ...Object.fromEntries(Object.entries(cfg.categoryWeights).map(([k, v]) => [`categoryWeight_${k}`, v])),
    bandLowBelow: cfg.bands.lowBelow, bandModerateBelow: cfg.bands.moderateBelow, bandHighBelow: cfg.bands.highBelow, weakEvidenceCap: cfg.weakEvidenceCap,
  };
}

export function computePriority(input: PriorityInput, options: PriorityOptions = {}): PriorityOutput {
  const cfg = options.config ?? DEFAULT_PRIORITY_CONFIG;
  const docIds = Object.keys(input.analyzerStatuses);
  const perDocument: Record<string, PriorityResult> = {};
  for (const docId of docIds) {
    perDocument[docId] = resultFor(input.findings.filter((f) => findingDocs(f).has(docId)), Object.values(input.analyzerStatuses[docId] ?? {}), cfg);
  }
  const allStatuses = docIds.flatMap((d) => Object.values(input.analyzerStatuses[d] ?? {}));
  const provenance: Provenance = {
    analyzer: "priorityEngine", analyzerVersion: ANALYZER_VERSION, config: configEcho(cfg), inputSha256: inputDigest(docIds, options.docSha256 ?? {}),
    processedAt: options.processedAt ?? DEFAULT_PROCESSED_AT, status: "AVAILABLE",
  };
  return { perCase: resultFor(input.findings, allStatuses, cfg), perDocument, provenance };
}
