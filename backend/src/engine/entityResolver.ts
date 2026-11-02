/**
 * B5: entity resolver. Pure, deterministic, never mutates its input.
 *
 * resolveEntities(assertions) -> { entities, assertions (with entityId and the entity's role set) }
 *
 * Rules
 *  - Parties first. Within one document, assertions with the same provisional role form one "party"
 *    (a form has an applicant party and a guarantor party; an id card is one party).
 *  - Strong identifiers (id_number, then account_number) merge parties by exact match. Merged entities are RESOLVED
 *    and `basis` names the identifier and the documents.
 *  - A merge is refused when it would put two different id_numbers or two different specific roles
 *    (applicant, co_applicant, guarantor, nominee) in one entity. The refusal is written into `basis`.
 *  - Name similarity NEVER merges. A party not confirmed by a cross-document identifier match that resembles exactly one
 *    compatible entity (token-sort >= 92, no conflicting id_number) becomes SUGGESTED with `suggestedLinks`.
 *    Resembling several entities, or none, leaves it UNRESOLVED.
 *  - Entities are numbered E-001... in order of the first assertion that belongs to them.
 *
 * Known limit: an OCR typo inside an id_number prevents the match (the parties stay separate and are not suggested,
 * because two different id_numbers count as hard evidence of different people).
 */
import type { DocumentAssertion, Entity, EntityRole } from "../../../contracts/types";
import engineConfig from "../../config/engine.json";
import { bestNameRatio, formatRatio } from "./nameSimilarity";

export interface ResolverConfig {
  /** token-sort ratio at or above which two entities may be SUGGESTED as the same */
  suggestMinRatio: number;
  /** token-sort ratio at or above which two entities with different id_numbers get an explanatory note */
  similarNameMinRatio: number;
}
export const DEFAULT_RESOLVER_CONFIG: ResolverConfig = engineConfig.entityResolver; // thresholds live in backend/config/engine.json

export interface ResolveResult {
  entities: Entity[];
  assertions: DocumentAssertion[];
}

const SPECIFIC: ReadonlySet<EntityRole> = new Set<EntityRole>(["applicant", "co_applicant", "guarantor", "nominee"]);
const keyOf = (v: string): string => v.normalize("NFC").replace(/\s+/g, "").toUpperCase();

interface Party {
  docId: string;
  role: EntityRole;
  idxs: number[]; // indices into the input assertions
  idKey: string | null;
  acctKey: string | null;
  names: string[];
}

interface Refusal { a: number; b: number; type: string; value: string; reason: string }

function bestKey(assertions: readonly DocumentAssertion[], idxs: readonly number[], semanticType: string): string | null {
  let best: { key: string; conf: number } | null = null;
  for (const i of idxs) {
    const a = assertions[i];
    if (!a || a.semanticType !== semanticType || a.normalizedValue == null) continue;
    const key = keyOf(a.normalizedValue);
    if (!key) continue;
    if (!best || a.extractionConfidence > best.conf) best = { key, conf: a.extractionConfidence };
  }
  return best ? best.key : null;
}

const rolesCompatible = (a: EntityRole, b: EntityRole): boolean =>
  a === b || a === "unknown" || b === "unknown" || a === "account_holder" || b === "account_holder";

export function resolveEntities(assertions: readonly DocumentAssertion[], config: ResolverConfig = DEFAULT_RESOLVER_CONFIG): ResolveResult {
  if (assertions.length === 0) return { entities: [], assertions: [] };
  const caseId = assertions[0]?.caseId ?? "";
  if (assertions.some((a) => a.caseId !== caseId)) throw new Error("resolveEntities: assertions from more than one case");

  // ---- parties
  const parties: Party[] = [];
  const partyIndex = new Map<string, number>();
  assertions.forEach((a, i) => {
    const k = `${a.docId}\u0000${a.entityRole}`;
    let pi = partyIndex.get(k);
    if (pi === undefined) {
      pi = parties.length;
      partyIndex.set(k, pi);
      parties.push({ docId: a.docId, role: a.entityRole, idxs: [], idKey: null, acctKey: null, names: [] });
    }
    parties[pi]?.idxs.push(i);
  });
  for (const p of parties) {
    p.idKey = bestKey(assertions, p.idxs, "id_number");
    p.acctKey = bestKey(assertions, p.idxs, "account_number");
    for (const i of p.idxs) {
      const a = assertions[i];
      if (a && a.semanticType === "full_name" && a.normalizedValue && !p.names.includes(a.normalizedValue)) p.names.push(a.normalizedValue);
    }
  }

  // ---- strong-identifier merges (id_number pass, then account_number pass)
  const groupOf = parties.map((_, i) => i);
  const members = new Map<number, number[]>(parties.map((_, i) => [i, [i]]));
  const refusals: Refusal[] = [];
  const tryMerge = (a: number, b: number, type: string, value: string): void => {
    const ga = groupOf[a] ?? a, gb = groupOf[b] ?? b;
    if (ga === gb) return;
    const all = [...(members.get(ga) ?? []), ...(members.get(gb) ?? [])];
    const ids = new Set(all.map((x) => parties[x]?.idKey).filter((x): x is string => !!x));
    const roles = [...new Set(all.map((x) => parties[x]?.role).filter((r): r is EntityRole => !!r && SPECIFIC.has(r)))].sort();
    if (ids.size > 1) { refusals.push({ a, b, type, value, reason: "id_number differs" }); return; }
    if (roles.length > 1) { refusals.push({ a, b, type, value, reason: `roles differ: ${roles.join(" vs ")}` }); return; }
    const keep = Math.min(ga, gb), drop = Math.max(ga, gb);
    const merged = all.sort((x, y) => x - y);
    members.set(keep, merged);
    members.delete(drop);
    for (const x of merged) groupOf[x] = keep;
  };
  for (const [type, pick] of [["id_number", (p: Party) => p.idKey], ["account_number", (p: Party) => p.acctKey]] as const) {
    const first = new Map<string, number>();
    parties.forEach((p, i) => {
      const k = pick(p);
      if (!k) return;
      const j = first.get(k);
      if (j === undefined) first.set(k, i);
      else tryMerge(i, j, type, k);
    });
  }

  // ---- entities, numbered by first assertion (= lowest party index in the group)
  const roots = [...members.keys()].sort((a, b) => a - b);
  const entityIdOfRoot = new Map<number, string>(roots.map((r, n) => [r, `E-${String(n + 1).padStart(3, "0")}`]));
  const entityOfParty = (p: number): string => entityIdOfRoot.get(groupOf[p] ?? p) ?? "";

  interface Group { root: number; entityId: string; parties: number[]; role: EntityRole; idKey: string | null; names: string[]; resolved: boolean }
  const groups: Group[] = roots.map((root) => {
    const ps = members.get(root) ?? [];
    const specific = [...new Set(ps.map((x) => parties[x]?.role).filter((r): r is EntityRole => !!r && SPECIFIC.has(r)))];
    const role: EntityRole = specific[0] ?? (ps.some((x) => parties[x]?.role === "account_holder") ? "account_holder" : "unknown");
    const idKey = ps.map((x) => parties[x]?.idKey).find((k): k is string => !!k) ?? null;
    const names = [...new Set(ps.flatMap((x) => parties[x]?.names ?? []))];
    return { root, entityId: entityIdOfRoot.get(root) ?? "", parties: ps, role, idKey, names, resolved: ps.length > 1 };
  });

  const basis = new Map<string, string[]>();
  const links = new Map<string, NonNullable<Entity["suggestedLinks"]>>();
  const resolution = new Map<string, Entity["resolution"]>();
  const add = (id: string, line: string): void => { const l = basis.get(id) ?? []; if (!l.includes(line)) l.push(line); basis.set(id, l); };

  // matches
  for (const g of groups) {
    for (const [type, pick] of [["id_number", (p: Party) => p.idKey], ["account_number", (p: Party) => p.acctKey]] as const) {
      const byValue = new Map<string, number[]>();
      for (const x of g.parties) { const p = parties[x]; const k = p ? pick(p) : null; if (k) byValue.set(k, [...(byValue.get(k) ?? []), x]); }
      for (const [value, ps] of byValue) {
        if (ps.length < 2) continue;
        const docs = [...new Set(ps.map((x) => parties[x]?.docId ?? ""))];
        add(g.entityId, `${type} exact match: ${value} (${docs.join(", ")})`);
      }
    }
    resolution.set(g.entityId, g.resolved ? "RESOLVED" : "UNRESOLVED");
  }
  // refused merges
  for (const r of refusals) {
    const ea = entityOfParty(r.a), eb = entityOfParty(r.b);
    if (ea === eb) continue;
    add(ea, `${r.type} ${r.value} also appears in ${eb} but the entities were not merged (${r.reason})`);
    add(eb, `${r.type} ${r.value} also appears in ${ea} but the entities were not merged (${r.reason})`);
  }
  // similar names, different id_numbers: keep separate and say why
  for (let i = 0; i < groups.length; i++) for (let j = i + 1; j < groups.length; j++) {
    const a = groups[i], b = groups[j];
    if (!a || !b || !a.idKey || !b.idKey || a.idKey === b.idKey) continue;
    const r = bestNameRatio(a.names, b.names);
    if (r < config.similarNameMinRatio) continue;
    add(a.entityId, `different id_number from ${b.entityId}, kept separate despite similar names (token-sort ratio ${formatRatio(r)})`);
    add(b.entityId, `different id_number from ${a.entityId}, kept separate despite similar names (token-sort ratio ${formatRatio(r)})`);
  }
  // suggestions (never merges)
  for (const g of groups) {
    if (g.resolved) continue;
    const cands = groups.flatMap((o) => {
      if (o === g || !rolesCompatible(g.role, o.role)) return [];
      if (g.idKey && o.idKey && g.idKey !== o.idKey) return [];
      const r = bestNameRatio(g.names, o.names);
      return r >= config.suggestMinRatio ? [{ o, r }] : [];
    });
    if (cands.length === 1 && cands[0]) {
      const { o, r } = cands[0];
      resolution.set(g.entityId, "SUGGESTED");
      links.set(g.entityId, [{ entityId: o.entityId, score: Math.round(r * 10) / 10, method: "name_token_sort" }]);
      add(g.entityId, `name similarity ${formatRatio(r)} to ${o.entityId} (suggested only, not merged)`);
    } else if (cands.length > 1) {
      add(g.entityId, `name matches several entities (${cands.map((c) => c.o.entityId).join(", ")}); no link suggested`);
    }
    add(g.entityId, "no cross-document strong identifier match");
  }

  // ---- outputs
  const entities: Entity[] = groups.map((g) => {
    const e: Entity = {
      entityId: g.entityId, caseId, role: g.role, resolution: resolution.get(g.entityId) ?? "UNRESOLVED",
      basis: basis.get(g.entityId) ?? [],
      assertionIds: g.parties.flatMap((x) => parties[x]?.idxs ?? []).sort((x, y) => x - y).map((i) => assertions[i]?.assertionId ?? ""),
    };
    const l = links.get(g.entityId);
    if (l) e.suggestedLinks = l;
    return e;
  });
  const roleOf = new Map(entities.map((e) => [e.entityId, e.role]));
  const out = assertions.map((a, i): DocumentAssertion => {
    const pi = partyIndex.get(`${a.docId}\u0000${a.entityRole}`) ?? 0;
    const entityId = entityOfParty(pi);
    void i;
    return { ...a, entityId, entityRole: roleOf.get(entityId) ?? a.entityRole, region: { ...a.region, bbox: [...a.region.bbox] as typeof a.region.bbox } };
  });
  return { entities, assertions: out };
}
