import type { DocType, DocumentAssertion, DocumentRecord, Entity, Finding } from "@contracts/types";
import type { GraphEdge, GraphNode, GraphResponse } from "@contracts/api";

export interface GraphInput {
  caseId: string;
  documents: DocumentRecord[]; // node order
  docTypes: Record<string, DocType | undefined>; // first-page type per document, when analysed
  fieldNames: Record<string, string>; // fieldId -> extractor field name (used to label match edges)
  assertions: DocumentAssertion[];
  entities: Entity[];
  findings: Finding[];
}

/** Identifiers that prove two documents talk about the same thing when their values are equal. */
const STRONG_IDENTIFIERS = new Set(["id_number", "account_number"]);

/**
 * Entity and document graph, derived from stored evidence (pure, deterministic).
 *  - contains: entity -> every document in which the entity has assertions.
 *  - match: documents that carry the same strong identifier value for one entity.
 *  - conflict: documents joined by an INCONSISTENT finding whose evidence spans them. Single-document findings
 *    (arithmetic, forensic) are not edges. Findings whose confidence was capped say "(capped)".
 *  - suggested: an entity that is only a SUGGESTED link, towards the entity its basis names.
 */
export function buildGraph(i: GraphInput): GraphResponse {
  const docOrder = new Map(i.documents.map((d, n) => [d.docId, n]));
  const byId = new Map(i.assertions.map((a) => [a.assertionId, a]));
  const byDoc = (a: string, b: string) => (docOrder.get(a) ?? 1e9) - (docOrder.get(b) ?? 1e9);

  const nodes: GraphNode[] = [
    ...i.documents.map((d): GraphNode => {
      const docType = i.docTypes[d.docId];
      return { id: d.docId, kind: "document", label: docType ? `${d.docId} ${docType}` : d.docId, ...(docType ? { docType } : {}) };
    }),
    ...i.entities.map((e): GraphNode => ({
      id: e.entityId, kind: "entity", label: `${e.role} (${e.entityId})`, role: e.role, resolution: e.resolution,
    })),
  ];

  const edges: GraphEdge[] = [];
  const add = (e: Omit<GraphEdge, "id">) => edges.push({ id: `G-${String(edges.length + 1).padStart(3, "0")}`, ...e });

  // contains
  for (const e of i.entities) {
    const docs = [...new Set(e.assertionIds.map((id) => byId.get(id)?.docId).filter((d): d is string => !!d && docOrder.has(d)))];
    for (const d of docs.sort(byDoc)) add({ source: e.entityId, target: d, kind: "contains" });
  }

  // match
  for (const e of i.entities) {
    const groups = new Map<string, DocumentAssertion[]>();
    for (const id of e.assertionIds) {
      const a = byId.get(id);
      if (!a || !STRONG_IDENTIFIERS.has(a.semanticType) || a.normalizedValue == null) continue;
      const key = `${a.semanticType}\u0000${a.normalizedValue}`;
      groups.set(key, [...(groups.get(key) ?? []), a]);
    }
    for (const list of groups.values()) {
      const perDoc = new Map<string, DocumentAssertion>();
      for (const a of list) if (!perDoc.has(a.docId)) perDoc.set(a.docId, a);
      const ordered = [...perDoc.values()].filter((a) => docOrder.has(a.docId)).sort((a, b) => byDoc(a.docId, b.docId));
      for (let n = 1; n < ordered.length; n++) {
        const later = ordered[n]!;
        add({
          source: ordered[n - 1]!.docId,
          target: later.docId,
          kind: "match",
          label: i.fieldNames[later.fieldId] ?? later.semanticType,
        });
      }
    }
  }

  // conflict
  for (const f of i.findings) {
    if (f.observationStatus !== "INCONSISTENT") continue;
    const docs: string[] = [];
    for (const ev of f.evidence) {
      for (const id of ev.assertionIds ?? []) {
        const d = byId.get(id)?.docId;
        if (d && docOrder.has(d) && !docs.includes(d)) docs.push(d);
      }
    }
    const capped = f.evidence.some((ev) => String(ev.measurements?.["confidenceCapped"]) === "true");
    for (let n = 1; n < docs.length; n++) {
      add({
        source: docs[n - 1]!,
        target: docs[n]!,
        kind: "conflict",
        findingId: f.findingId,
        label: capped ? `${f.type} (capped)` : f.type,
      });
    }
  }

  // suggested
  const entityIds = new Set(i.entities.map((e) => e.entityId));
  for (const e of i.entities) {
    if (e.resolution !== "SUGGESTED") continue;
    const target = e.basis
      .flatMap((b) => b.match(/[A-Za-z]+-\d+/g) ?? [])
      .find((id) => entityIds.has(id) && id !== e.entityId);
    if (!target) continue;
    add({
      source: e.entityId,
      target,
      kind: "suggested",
      label: e.basis.some((b) => /name similarity/i.test(b)) ? "name similarity only" : "suggested link",
    });
  }

  return { caseId: i.caseId, nodes, edges };
}
