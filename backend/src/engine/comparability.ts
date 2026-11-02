/**
 * B6: comparability rules. evaluate(assertions, entities, options) -> Finding[]  (pure, deterministic)
 *
 * MUST_AGREE rules compare assertions of the SAME entity that come from different documents, and also, with confidence
 * capped, across a SUGGESTED link (Entity.suggestedLinks). Different RESOLVED entities are never compared.
 * MAY_DIFFER and NOT_COMPARABLE rules produce no finding; they guard pairs of different semantic types that a broader
 * rule would otherwise compare (see legitimateDifference in ruleSupport.ts). Every finding records the rule id and why
 * no legitimate-difference rule applied. ARITHMETIC, TEMPORAL and UNIQUENESS rules live in contextRules.ts.
 *
 * Findings are numbered F-0001... and evidence E-0001... in rule-table order; options.idStart continues a numbering.
 */
import type { ComparabilityRule, DocumentAssertion, Entity, Finding } from "../../../contracts/types";
import { evaluateContextRule } from "./contextRules";
import { tokenSortRatio } from "./nameSimilarity";
import {
  type Ctx, type EvaluateOptions, type FindingDraft, capSeverity, comparabilityConfigEcho, entityAssertions, legitimateDifference, pad, provenance,
  resolveOptions, roleLabel, round2, ruleAppliesTo,
} from "./ruleSupport";
import { amountsEqual, exactEqual, isDayMonthSwap } from "./valueCompare";

export type { EvaluateOptions } from "./ruleSupport";
export { nextIdStart } from "./ruleSupport";

const LABELS: Record<string, string> = { dob: "date-of-birth", full_name: "name" };
const label = (sem: string): string => LABELS[sem] ?? sem.replace(/_/g, " ");
const round1 = (v: number): number => Math.round(v * 10) / 10;

type Kind = "mismatch" | "variant" | "swap";
interface Verdict { kind: Kind; extra: Record<string, number | string> }

function verdict(ctx: Ctx, rule: ComparabilityRule, a: DocumentAssertion, b: DocumentAssertion): Verdict | null {
  const va = a.normalizedValue ?? "", vb = b.normalizedValue ?? "";
  switch (rule.matchMethod) {
    case "name_fuzzy": {
      const r = tokenSortRatio(va, vb);
      if (r >= ctx.opts.cmp.nameMatchMin) return null;
      return { kind: r >= ctx.opts.cmp.nameVariantMin ? "variant" : "mismatch", extra: { tokenSortRatio: round1(r) } };
    }
    case "date_iso":
      if (va === vb) return null;
      return isDayMonthSwap(va, vb) ? { kind: "swap", extra: { dayMonthSwap: "true" } } : { kind: "mismatch", extra: { dayMonthSwap: "false" } };
    case "amount_exact": return amountsEqual(va, vb) ? null : { kind: "mismatch", extra: {} };
    case "exact": return exactEqual(a.semanticType, va, vb) ? null : { kind: "mismatch", extra: {} };
    default: return null;
  }
}

interface PairContext { entityA: Entity; entityB: Entity; link: boolean }

function pairFinding(ctx: Ctx, rule: ComparabilityRule, a: DocumentAssertion, b: DocumentAssertion, pc: PairContext): FindingDraft | null {
  const v = verdict(ctx, rule, a, b);
  if (!v) return null;
  const capped = pc.entityA.resolution !== "RESOLVED" || pc.entityB.resolution !== "RESOLVED";
  const baseType = rule.findingType ?? `${a.semanticType.toUpperCase()}_CONFLICT`;
  const stem = baseType.replace(/_CONFLICT$/, "");
  const type = v.kind === "variant" ? `${stem}_VARIANT_SPELLING` : v.kind === "swap" ? `${stem}_DAY_MONTH_SWAP` : baseType;
  const severity = v.kind === "variant" ? capSeverity("low", rule.severity) : v.kind === "swap" ? capSeverity("medium", rule.severity) : rule.severity;
  const raw = Math.min(a.extractionConfidence, b.extractionConfidence);
  const confidence = round2(capped ? Math.min(raw, ctx.opts.cmp.unresolvedConfidenceCap) : raw);
  const sem = a.semanticType === b.semanticType ? a.semanticType : `${a.semanticType} vs ${b.semanticType}`;
  const rid = `(rule: ${rule.ruleId}, ${rule.ruleType})`;
  const slightly = v.kind === "variant" ? " slightly" : "";
  const description = pc.link
    ? `${sem} differs${slightly}; the ${roleLabel(pc.entityA.role)} is only a ${pc.entityA.resolution} link to the ${roleLabel(pc.entityB.role)}, so confidence is capped (rule: ${rule.ruleId})`
    : v.kind === "swap"
      ? `${sem} day and month appear swapped for the same ${pc.entityA.resolution.toLowerCase()} ${roleLabel(pc.entityA.role)} ${rid}`
      : `${sem} differs${slightly} for the same ${pc.entityA.resolution.toLowerCase()} ${roleLabel(pc.entityA.role)} ${rid}${capped ? ", so confidence is capped" : ""}`;
  const lbl = label(a.semanticType);
  const verify: string[] = [];
  if (pc.link) verify.push(`Confirm that the ${roleLabel(pc.entityA.role)} is the same person as the ${roleLabel(pc.entityB.role)}`);
  if (v.kind === "variant") {
    verify.push(!pc.link && a.semanticType === "full_name" ? "Compare the name regions on both documents; a missing middle name is a common variation" : `Compare the ${lbl} regions on both documents`);
  } else if (v.kind === "swap") verify.push(`Inspect both ${lbl} regions on the original documents; day and month may be transposed`);
  else verify.push(`Inspect both ${lbl} regions on the original documents`);
  const measurements: Record<string, number | string> = {
    ruleId: rule.ruleId, ruleType: rule.ruleType, valueA: a.normalizedValue ?? "", valueB: b.normalizedValue ?? "", ...v.extra,
    entityResolution: pc.entityA.resolution, ...(capped ? { confidenceCapped: "true" } : {}),
    legitimateDifferenceRules: a.semanticType === b.semanticType ? `none apply to semantic type ${a.semanticType}` : `none apply to ${a.semanticType} vs ${b.semanticType}`,
  };
  return {
    caseId: a.caseId, category: "cross_document", type, observationStatus: "INCONSISTENT", severity, confidence,
    evidence: [{
      kind: "assertion_pair", description, regions: [a.region, b.region], assertionIds: [a.assertionId, b.assertionId], measurements,
      provenance: provenance(ctx, "comparability", comparabilityConfigEcho(ctx.opts.cmp), [a.docId, b.docId]),
    }],
    needsVerification: verify,
  };
}

function mustAgree(ctx: Ctx, rule: ComparabilityRule): FindingDraft[] {
  const out: FindingDraft[] = [];
  const seen = new Set<string>();
  const tryPair = (x: DocumentAssertion, y: DocumentAssertion, pc: (first: DocumentAssertion) => PairContext): void => {
    if (x.docId === y.docId) return; // MUST_AGREE compares across documents
    const [a, b] = (ctx.indexOf.get(x.assertionId) ?? 0) <= (ctx.indexOf.get(y.assertionId) ?? 0) ? [x, y] : [y, x];
    const key = `${rule.ruleId}|${a.assertionId}|${b.assertionId}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (legitimateDifference(ctx.opts.rules, a.semanticType, b.semanticType)) return;
    const f = pairFinding(ctx, rule, a, b, pc(a));
    if (f) out.push(f);
  };
  for (const entity of ctx.entities) {
    if (!ruleAppliesTo(rule, entity)) continue;
    const own = entityAssertions(ctx, entity, rule.semanticTypes);
    for (let i = 0; i < own.length; i++) for (let j = i + 1; j < own.length; j++) {
      const x = own[i], y = own[j];
      if (x && y) tryPair(x, y, () => ({ entityA: entity, entityB: entity, link: false }));
    }
    // across a SUGGESTED link: compared, but the finding is capped and says so
    for (const link of entity.suggestedLinks ?? []) {
      const target = ctx.entityById.get(link.entityId);
      if (!target || !ruleAppliesTo(rule, target)) continue;
      const theirs = entityAssertions(ctx, target, rule.semanticTypes);
      for (const x of own) for (const y of theirs) tryPair(x, y, () => ({ entityA: entity, entityB: target, link: true }));
    }
  }
  return out;
}

export function evaluate(assertions: readonly DocumentAssertion[], entities: readonly Entity[], options: EvaluateOptions = {}): Finding[] {
  const opts = resolveOptions(options);
  const ctx: Ctx = {
    assertions, entities, entityById: new Map(entities.map((e) => [e.entityId, e])),
    indexOf: new Map(assertions.map((a, i) => [a.assertionId, i])), opts,
  };
  const drafts: FindingDraft[] = [];
  for (const rule of opts.rules) {
    if (rule.ruleType === "MUST_AGREE") drafts.push(...mustAgree(ctx, rule));
    else drafts.push(...evaluateContextRule(ctx, rule)); // MAY_DIFFER and NOT_COMPARABLE rules never produce findings
  }
  let fn = options.idStart?.finding ?? 1, en = options.idStart?.evidence ?? 1;
  return drafts.map((d): Finding => ({
    findingId: `F-${pad(fn++, 4)}`, ...d,
    evidence: d.evidence.map((e) => ({ evidenceId: `E-${pad(en++, 4)}`, ...e })),
  }));
}
