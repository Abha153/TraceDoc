/**
 * Cross-case correlation: which strong identifiers or identical files also appear in another case.
 *
 * This is a lead for the analyst, not a finding. It never changes priority, never merges entities across cases and
 * never compares names, addresses or amounts. Pure and deterministic (no I/O): the caller supplies what each case holds.
 *
 * Matched on: normalized id_number and account_number (exact), and the SHA-256 of the stored original (exact).
 */
import type { CorrelationRef, RelatedCase, SharedValue } from "../../../contracts/api";

export const CORRELATED_SEMANTIC_TYPES = ["id_number", "account_number"] as const;

export interface CorrelationCase {
  caseId: string;
  title: string;
  assertions: ReadonlyArray<{ assertionId: string; docId: string; semanticType: string; normalizedValue: string | null }>;
  documents: ReadonlyArray<{ docId: string; sha256: string }>;
}

type Key = string; // "identifier|id_number|<value>" or "file_hash||<sha>"

function index(c: CorrelationCase): Map<Key, { shared: Omit<SharedValue, "otherCase" | "thisCase">; refs: CorrelationRef[] }> {
  const m = new Map<Key, { shared: Omit<SharedValue, "otherCase" | "thisCase">; refs: CorrelationRef[] }>();
  const add = (key: Key, shared: Omit<SharedValue, "otherCase" | "thisCase">, ref: CorrelationRef) => {
    const hit = m.get(key);
    if (hit) hit.refs.push(ref);
    else m.set(key, { shared, refs: [ref] });
  };
  for (const a of c.assertions) {
    if (!(CORRELATED_SEMANTIC_TYPES as readonly string[]).includes(a.semanticType)) continue;
    if (!a.normalizedValue) continue;
    add(`identifier|${a.semanticType}|${a.normalizedValue}`, { kind: "identifier", semanticType: a.semanticType, value: a.normalizedValue }, { docId: a.docId, assertionId: a.assertionId });
  }
  for (const d of c.documents) {
    if (!d.sha256) continue;
    add(`file_hash||${d.sha256}`, { kind: "file_hash", value: d.sha256 }, { docId: d.docId });
  }
  return m;
}

const byRef = (a: CorrelationRef, b: CorrelationRef) => a.docId.localeCompare(b.docId) || (a.assertionId ?? "").localeCompare(b.assertionId ?? "");

export function correlateCases(current: CorrelationCase, others: readonly CorrelationCase[]): RelatedCase[] {
  const mine = index(current);
  const out: RelatedCase[] = [];
  for (const other of others) {
    if (other.caseId === current.caseId) continue;
    const theirs = index(other);
    const shared: SharedValue[] = [];
    for (const [key, m] of mine) {
      const t = theirs.get(key);
      if (!t) continue;
      shared.push({ ...m.shared, thisCase: [...m.refs].sort(byRef), otherCase: [...t.refs].sort(byRef) });
    }
    if (shared.length === 0) continue;
    shared.sort((a, b) => a.kind.localeCompare(b.kind) || (a.semanticType ?? "").localeCompare(b.semanticType ?? "") || a.value.localeCompare(b.value));
    out.push({ caseId: other.caseId, title: other.title, shared });
  }
  return out.sort((a, b) => b.shared.length - a.shared.length || a.caseId.localeCompare(b.caseId));
}

export const CORRELATION_BASIS =
  "Compared exact id_number and account_number values and file hashes with every other case. A match is a lead to verify: " +
  "the same person can appear in more than one case, and a match does not indicate wrongdoing. Names, addresses and amounts are not compared.";
