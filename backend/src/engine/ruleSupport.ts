/**
 * Shared plumbing for the rule modules (B6): configuration, severity helpers, provenance, id assignment.
 * Pure: no I/O, no clock. Anything time or hash related comes in through the options.
 */
import { createHash } from "node:crypto";
import type { ComparabilityRule, DocumentAssertion, Entity, Evidence, Finding, Provenance, Severity } from "../../../contracts/types";
import engineConfig from "../../config/engine.json";
import comparabilityRules from "../../config/comparability.json";

export interface ComparabilityConfig { nameMatchMin: number; nameVariantMin: number; unresolvedConfidenceCap: number }
export interface ContextConfig { arithmeticToleranceCents: number }

export interface EvaluateOptions {
  /** Rule table; defaults to backend/config/comparability.json. */
  rules?: readonly ComparabilityRule[];
  comparability?: ComparabilityConfig;
  context?: ContextConfig;
  /** docId -> SHA-256 of the original document, for provenance. A missing entry becomes 64 zeros. */
  docSha256?: Readonly<Record<string, string>>;
  /** Timestamp written into provenance (the engine has no clock). */
  processedAt?: string;
  /** First numbers to use for finding and evidence ids (default 1). */
  idStart?: { finding: number; evidence: number };
}

export const DEFAULT_RULES = comparabilityRules as unknown as ComparabilityRule[];
export const DEFAULT_COMPARABILITY: ComparabilityConfig = engineConfig.comparability;
export const DEFAULT_CONTEXT: ContextConfig = engineConfig.contextRules;
export const DEFAULT_PROCESSED_AT = "1970-01-01T00:00:00Z";
export const ZERO_SHA = "0".repeat(64);
export const ANALYZER_VERSION = "0.1";

export interface Resolved {
  rules: readonly ComparabilityRule[];
  cmp: ComparabilityConfig;
  ctx: ContextConfig;
  docSha256: Readonly<Record<string, string>>;
  processedAt: string;
}
export const resolveOptions = (o: EvaluateOptions = {}): Resolved => ({
  rules: o.rules ?? DEFAULT_RULES, cmp: o.comparability ?? DEFAULT_COMPARABILITY, ctx: o.context ?? DEFAULT_CONTEXT,
  docSha256: o.docSha256 ?? {}, processedAt: o.processedAt ?? DEFAULT_PROCESSED_AT,
});

/** Draft = finding without ids; evaluate() numbers them in rule-table order. */
export type EvidenceDraft = Omit<Evidence, "evidenceId">;
export type FindingDraft = Omit<Finding, "findingId" | "evidence"> & { evidence: EvidenceDraft[] };

export interface Ctx {
  assertions: readonly DocumentAssertion[];
  entities: readonly Entity[];
  entityById: ReadonlyMap<string, Entity>;
  indexOf: ReadonlyMap<string, number>; // assertionId -> input order
  opts: Resolved;
}

export const SEVERITY_RANK: Record<Severity, number> = { info: 0, low: 1, medium: 2, high: 3 };
export const capSeverity = (s: Severity, max: Severity): Severity => (SEVERITY_RANK[s] <= SEVERITY_RANK[max] ? s : max);

export const round2 = (v: number): number => Math.round(v * 100) / 100;

/** One doc: its own sha256. Several docs: sha256 of the sorted shas joined by newlines. */
export function inputDigest(docIds: readonly string[], docSha256: Readonly<Record<string, string>>): string {
  const shas = [...new Set(docIds)].map((d) => docSha256[d] ?? ZERO_SHA).sort();
  return shas.length === 1 ? (shas[0] ?? ZERO_SHA) : createHash("sha256").update(shas.join("\n")).digest("hex");
}

export function provenance(ctx: Ctx, analyzer: string, config: Record<string, number | string>, docIds: readonly string[]): Provenance {
  return { analyzer, analyzerVersion: ANALYZER_VERSION, config, inputSha256: inputDigest(docIds, ctx.opts.docSha256), processedAt: ctx.opts.processedAt, status: "AVAILABLE" };
}

export const comparabilityConfigEcho = (c: ComparabilityConfig): Record<string, number> => ({
  nameMatchMin: c.nameMatchMin, nameVariantMin: c.nameVariantMin, unresolvedConfidenceCap: c.unresolvedConfidenceCap,
});
export const contextConfigEcho = (c: ContextConfig): Record<string, number> => ({ arithmeticToleranceCents: c.arithmeticToleranceCents });

export const roleLabel = (r: string): string => r.replace(/_/g, " ");

/** Rule applies to an entity when the entity's role is listed. */
export const ruleAppliesTo = (rule: ComparabilityRule, entity: Entity | undefined): boolean => !!entity && rule.entityRoles.includes(entity.role);

/** Assertions of an entity with one of the given semantic types and a usable value, in input order. */
export function entityAssertions(ctx: Ctx, entity: Entity, types: readonly string[]): DocumentAssertion[] {
  const ids = new Set(entity.assertionIds);
  return ctx.assertions.filter((a) => ids.has(a.assertionId) && types.includes(a.semanticType) && a.normalizedValue !== null && a.normalizedValue !== "");
}

/**
 * MAY_DIFFER / NOT_COMPARABLE guard. A rule listing several semantic types says pairs of two DIFFERENT listed types may differ;
 * a rule listing exactly one type says that type may differ across documents. Returns the guarding rule, if any.
 */
export function legitimateDifference(rules: readonly ComparabilityRule[], ta: string, tb: string): ComparabilityRule | null {
  for (const r of rules) {
    if (r.ruleType !== "MAY_DIFFER" && r.ruleType !== "NOT_COMPARABLE") continue;
    const set = r.semanticTypes;
    if (ta === tb ? set.length === 1 && set[0] === ta : set.includes(ta) && set.includes(tb)) return r;
  }
  return null;
}

/** Next unused finding / evidence numbers for a list of findings (for B7b, which appends event findings). */
export function nextIdStart(findings: readonly Finding[]): { finding: number; evidence: number } {
  let f = 0, e = 0;
  for (const x of findings) {
    f = Math.max(f, Number(/^F-(\d+)$/.exec(x.findingId)?.[1] ?? 0));
    for (const ev of x.evidence) e = Math.max(e, Number(/^E-(\d+)$/.exec(ev.evidenceId)?.[1] ?? 0));
  }
  return { finding: f + 1, evidence: e + 1 };
}

export const pad = (n: number, w: number): string => String(n).padStart(w, "0");
