/**
 * B6: context rules. ARITHMETIC (row amounts must add up to a printed total), TEMPORAL (a date that must precede another)
 * and UNIQUENESS (one identifier, one entity). Pure; called by evaluate() in comparability.ts, one rule at a time.
 *
 * Honesty: when an arithmetic check cannot be performed because row amounts are missing or unreadable, the rule emits an
 * INCONCLUSIVE info finding instead of staying silent, so "could not check" is never mistaken for "checked and fine".
 */
import type { ComparabilityRule, DocumentAssertion, Entity } from "../../../contracts/types";
import {
  type Ctx, type FindingDraft, contextConfigEcho, provenance, round2, roleLabel, ruleAppliesTo, entityAssertions,
} from "./ruleSupport";
import { SCALE_PER_CENT, formatScaled, identifierKey, textKey, toScaled } from "./valueCompare";
import { valueKindOf } from "./assertions";

const minConf = (as: readonly DocumentAssertion[]): number => round2(Math.min(...as.map((a) => a.extractionConfidence)));
const entityOf = (ctx: Ctx, a: DocumentAssertion): Entity | undefined => (a.entityId ? ctx.entityById.get(a.entityId) : undefined);

export function evaluateContextRule(ctx: Ctx, rule: ComparabilityRule): FindingDraft[] {
  switch (rule.ruleType) {
    case "ARITHMETIC": return arithmetic(ctx, rule);
    case "TEMPORAL": return temporal(ctx, rule);
    case "UNIQUENESS": return uniqueness(ctx, rule);
    default: return [];
  }
}

// ------------------------------------------------------------------------------------------------ ARITHMETIC
function arithmetic(ctx: Ctx, rule: ComparabilityRule): FindingDraft[] {
  const [itemType, totalType] = rule.semanticTypes;
  if (!itemType || !totalType || rule.matchMethod !== "sum_equals") return [];
  const baseType = rule.findingType ?? "ARITHMETIC_MISMATCH";
  const out: FindingDraft[] = [];
  const docs = [...new Set(ctx.assertions.filter((a) => a.semanticType === itemType || a.semanticType === totalType).map((a) => a.docId))];
  for (const docId of docs) {
    const inDoc = ctx.assertions.filter((a) => a.docId === docId);
    const items = inDoc.filter((a) => a.semanticType === itemType);
    for (const total of inDoc.filter((a) => a.semanticType === totalType && a.normalizedValue !== null)) {
      if (!ruleAppliesTo(rule, entityOf(ctx, total))) continue;
      const printed = toScaled(total.normalizedValue ?? "");
      const unreadable = items.filter((i) => i.normalizedValue === null || toScaled(i.normalizedValue) === null);
      const prov = provenance(ctx, "contextRules", contextConfigEcho(ctx.opts.ctx), [docId]);
      const involved = [total, ...items];
      const regions = involved.map((a) => a.region);
      const assertionIds = involved.map((a) => a.assertionId);
      if (printed === null || items.length === 0 || unreadable.length > 0) {
        out.push({
          caseId: total.caseId, category: "context", type: baseType.replace(/_MISMATCH$/, "") + "_UNVERIFIABLE", observationStatus: "INCONCLUSIVE",
          severity: "info", confidence: minConf(involved),
          evidence: [{
            kind: "rule_result", regions, assertionIds, provenance: prov,
            description: `The printed total could not be checked because ${items.length === 0 ? "no listed amounts were found" : "some listed amounts could not be read"} (rule: ${rule.ruleId}, ARITHMETIC)`,
            measurements: { ruleId: rule.ruleId, ruleType: rule.ruleType, itemCount: items.length, unreadableCount: unreadable.length },
          }],
          needsVerification: ["Read the listed amounts on the original document and compare them with the printed total"],
        });
        continue;
      }
      const computed = items.reduce((s, i) => s + (toScaled(i.normalizedValue ?? "") ?? 0n), 0n);
      const diff = printed - computed;
      const tolerance = BigInt(ctx.opts.ctx.arithmeticToleranceCents) * SCALE_PER_CENT;
      if ((diff < 0n ? -diff : diff) <= tolerance) continue;
      out.push({
        caseId: total.caseId, category: "context", type: baseType, observationStatus: "INCONSISTENT", severity: rule.severity, confidence: minConf(involved),
        evidence: [{
          kind: "rule_result", regions, assertionIds, provenance: prov,
          description: `Printed total does not equal the sum of the listed amounts (rule: ${rule.ruleId}, ${rule.ruleType})`,
          measurements: {
            ruleId: rule.ruleId, ruleType: rule.ruleType, printedTotal: total.normalizedValue ?? "", computedTotal: formatScaled(computed),
            difference: formatScaled(diff), itemCount: items.length,
          },
        }],
        needsVerification: ["Recompute the listed amounts and compare with the printed total on the original document"],
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ TEMPORAL
/** semanticTypes[0] must be strictly before semanticTypes[1], for assertions of the same entity (any documents). */
function temporal(ctx: Ctx, rule: ComparabilityRule): FindingDraft[] {
  const [first, second] = rule.semanticTypes;
  if (!first || !second || rule.matchMethod !== "date_order" || !rule.findingType) return [];
  const out: FindingDraft[] = [];
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  for (const entity of ctx.entities) {
    if (!ruleAppliesTo(rule, entity)) continue;
    const earlier = entityAssertions(ctx, entity, [first]).filter((a) => iso.test(a.normalizedValue ?? ""));
    const later = entityAssertions(ctx, entity, [second]).filter((a) => iso.test(a.normalizedValue ?? ""));
    for (const a of earlier) for (const b of later) {
      const va = a.normalizedValue ?? "", vb = b.normalizedValue ?? "";
      if (va < vb) continue; // ISO dates sort as strings
      out.push({
        caseId: a.caseId, category: "context", type: rule.findingType, observationStatus: "INCONSISTENT", severity: rule.severity, confidence: minConf([a, b]),
        evidence: [{
          kind: "assertion_pair", regions: [a.region, b.region], assertionIds: [a.assertionId, b.assertionId],
          provenance: provenance(ctx, "contextRules", contextConfigEcho(ctx.opts.ctx), [a.docId, b.docId]),
          description: `${first} ${va} is not before ${second} ${vb} for the same ${entity.resolution.toLowerCase()} ${roleLabel(entity.role)} (rule: ${rule.ruleId}, ${rule.ruleType})`,
          measurements: { ruleId: rule.ruleId, ruleType: rule.ruleType, valueA: va, valueB: vb, requiredOrder: `${first} before ${second}` },
        }],
        needsVerification: ["Check both dates on the original documents"],
      });
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ UNIQUENESS
function uniqueness(ctx: Ctx, rule: ComparabilityRule): FindingDraft[] {
  if (!rule.findingType) return [];
  const groups = new Map<string, DocumentAssertion[]>();
  for (const a of ctx.assertions) {
    if (!rule.semanticTypes.includes(a.semanticType) || a.normalizedValue === null || a.normalizedValue === "" || !a.entityId) continue;
    if (!ruleAppliesTo(rule, ctx.entityById.get(a.entityId))) continue;
    const key = `${a.semanticType}\u0000${valueKindOf(a.semanticType) === "identifier" ? identifierKey(a.normalizedValue) : textKey(a.normalizedValue)}`;
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }
  const out: FindingDraft[] = [];
  for (const members of groups.values()) {
    const firstPerEntity = new Map<string, DocumentAssertion>();
    for (const a of members) if (a.entityId && !firstPerEntity.has(a.entityId)) firstPerEntity.set(a.entityId, a);
    if (firstPerEntity.size < 2) continue;
    const picked = [...firstPerEntity.values()];
    const roles = picked.map((a) => roleLabel(ctx.entityById.get(a.entityId ?? "")?.role ?? "unknown"));
    const first = picked[0];
    if (!first) continue;
    out.push({
      caseId: first.caseId, category: "cross_document", type: rule.findingType, observationStatus: "POTENTIAL_ANOMALY", severity: rule.severity, confidence: minConf(picked),
      evidence: [{
        kind: "assertion_pair", regions: picked.map((a) => a.region), assertionIds: picked.map((a) => a.assertionId),
        provenance: provenance(ctx, "contextRules", contextConfigEcho(ctx.opts.ctx), picked.map((a) => a.docId)),
        description: `${first.semanticType} ${first.normalizedValue ?? ""} appears under ${picked.length} different entities (${roles.join(" and ")}) (rule: ${rule.ruleId}, ${rule.ruleType})`,
        measurements: {
          ruleId: rule.ruleId, ruleType: rule.ruleType, value: first.normalizedValue ?? "", entityIds: picked.map((a) => a.entityId ?? "").join(","), entityRoles: roles.join(","),
        },
      }],
      needsVerification: ["Check whether one person is listed in several roles, or whether the identifier was reused or misread"],
    });
  }
  return out;
}
