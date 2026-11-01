import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { ReasoningOutput } from "../../../contracts/reasoning";
import type { AnalyzeResponse, DocumentAssertion, EntityRole } from "../../../contracts/types";
import { buildAssertions } from "./assertions";
import { resolveEntities } from "./entityResolver";
import { bestNameRatio, tokenSortRatio } from "./nameSimilarity";

const fx = resolve(dirname(fileURLToPath(import.meta.url)), "../../../contracts/fixtures");
const readJson = <T>(p: string): T => JSON.parse(readFileSync(resolve(fx, p), "utf8")) as T;
const CASES: Record<string, string[]> = { "CASE-001": ["D-01", "D-02", "D-03"], "CASE-002": ["D-11", "D-12", "D-13"] };

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") { Object.values(o as object).forEach(deepFreeze); Object.freeze(o); }
  return o;
}

let seq = 0;
/** Small hand-built assertion. */
function A(docId: string, role: EntityRole, semanticType: string, value: string | null, conf = 0.9): DocumentAssertion {
  seq++;
  return {
    assertionId: `${docId}-A${String(seq).padStart(3, "0")}`, caseId: "C", docId, fieldId: `${docId}-F${seq}`, entityId: null, entityRole: role,
    semanticType, normalizedValue: value, extractionConfidence: conf, region: { docId, page: 1, bbox: [0.1, 0.1, 0.2, 0.05] },
  };
}
const byId = (r: ReturnType<typeof resolveEntities>, docId: string, role?: EntityRole) =>
  r.entities.find((e) => e.assertionIds.some((id) => id.startsWith(docId + "-")) && (role === undefined || e.role === role));

describe("fixtures", () => {
  for (const [caseId, docs] of Object.entries(CASES)) {
    it(`${caseId}: entities and assertion links equal the fixture reasoning output`, () => {
      const a = docs.map((d) => readJson<AnalyzeResponse>(`analyze/${d}.json`));
      const exp = readJson<ReasoningOutput>(`${caseId}.reasoning.json`);
      const got = resolveEntities(buildAssertions(a.flatMap((x) => x.fields), a.flatMap((x) => x.pages), caseId));
      assert.deepStrictEqual(got.entities, exp.entities);
      assert.deepStrictEqual(got.assertions, exp.assertions);
    });
  }
  it("CASE-002: applicant and guarantor with similar names are never merged", () => {
    const docs = CASES["CASE-002"] ?? [];
    const a = docs.map((d) => readJson<AnalyzeResponse>(`analyze/${d}.json`));
    const got = resolveEntities(buildAssertions(a.flatMap((x) => x.fields), a.flatMap((x) => x.pages), "CASE-002"));
    assert.equal(got.entities.length, 2);
    assert.deepEqual(got.entities.map((e) => e.role), ["applicant", "guarantor"]);
    assert.ok(got.entities.every((e) => e.resolution === "RESOLVED" && !e.suggestedLinks));
    const nameOf = (docId: string) => got.assertions.find((x) => x.docId === docId && x.semanticType === "full_name")!;
    assert.notEqual(nameOf("D-11").entityId, nameOf("D-12").entityId);
    assert.equal(nameOf("D-12").entityId, got.assertions.find((x) => x.fieldId === "D-13-F08")!.entityId); // guarantor name on the form
  });
  it("CASE-001: a name that differs but shares the id_number merges, and a differing dob does not block it", () => {
    const docs = CASES["CASE-001"] ?? [];
    const a = docs.map((d) => readJson<AnalyzeResponse>(`analyze/${d}.json`));
    const got = resolveEntities(buildAssertions(a.flatMap((x) => x.fields), a.flatMap((x) => x.pages), "CASE-001"));
    const dob = got.assertions.filter((x) => x.semanticType === "dob");
    assert.equal(dob.length, 2);
    assert.notEqual(dob[0]!.normalizedValue, dob[1]!.normalizedValue);
    assert.equal(dob[0]!.entityId, dob[1]!.entityId);
  });
});

describe("merging rules", () => {
  it("a name typo with a matching id_number merges (RESOLVED)", () => {
    const r = resolveEntities([
      A("D-A", "unknown", "full_name", "Aarav Sharma"), A("D-A", "unknown", "id_number", "TD-1"),
      A("D-B", "applicant", "full_name", "Aarv Sharmaa"), A("D-B", "applicant", "id_number", "TD-1"),
    ]);
    assert.equal(r.entities.length, 1);
    assert.equal(r.entities[0]?.resolution, "RESOLVED");
    assert.equal(r.entities[0]?.role, "applicant");
    assert.deepEqual(r.entities[0]?.basis, ["id_number exact match: TD-1 (D-A, D-B)"]);
    assert.ok(r.assertions.every((x) => x.entityId === "E-001" && x.entityRole === "applicant"));
  });
  it("id_number matching ignores case and whitespace", () => {
    const r = resolveEntities([A("D-A", "unknown", "id_number", "td-1"), A("D-B", "unknown", "id_number", "TD- 1")]);
    assert.equal(r.entities.length, 1);
  });
  it("identical names alone never merge: they become a SUGGESTED link", () => {
    const r = resolveEntities([A("D-A", "unknown", "full_name", "John Smith"), A("D-B", "applicant", "full_name", "John Smith")]);
    assert.equal(r.entities.length, 2);
    assert.ok(r.entities.every((e) => e.resolution !== "RESOLVED"));
    const sug = r.entities.filter((e) => e.resolution === "SUGGESTED");
    assert.ok(sug.length >= 1);
    for (const e of sug) assert.equal(e.suggestedLinks?.[0]?.method, "name_token_sort");
  });
  it("applicant and guarantor with the same name and no ids stay separate and unrelated", () => {
    const r = resolveEntities([A("D-A", "applicant", "full_name", "Priya Nair"), A("D-A", "guarantor", "full_name", "Priya Nair")]);
    assert.equal(r.entities.length, 2);
    assert.deepEqual(r.entities.map((e) => e.resolution), ["UNRESOLVED", "UNRESOLVED"]);
    assert.ok(r.entities.every((e) => !e.suggestedLinks));
  });
  it("the same id_number under conflicting specific roles is not merged, and says why", () => {
    const r = resolveEntities([A("D-A", "applicant", "id_number", "TD-1"), A("D-A", "guarantor", "id_number", "TD-1")]);
    assert.equal(r.entities.length, 2);
    assert.ok(r.entities[0]?.basis.some((b) => /not merged \(roles differ: applicant vs guarantor\)/.test(b)));
    assert.ok(r.entities.every((e) => e.resolution === "UNRESOLVED"));
  });
  it("different id_numbers never merge, even through a shared account_number", () => {
    const r = resolveEntities([
      A("D-A", "applicant", "id_number", "TD-1"), A("D-A", "applicant", "account_number", "AC-9"),
      A("D-B", "account_holder", "id_number", "TD-2"), A("D-B", "account_holder", "account_number", "AC-9"),
    ]);
    assert.equal(r.entities.length, 2);
    assert.ok(r.entities[0]?.basis.some((b) => /id_number differs/.test(b)));
  });
  it("an account_number match merges account documents, and an id card links through id_number", () => {
    const r = resolveEntities([
      A("S-1", "account_holder", "account_number", "AC-9"), A("S-2", "account_holder", "account_number", "AC-9"),
      A("D-A", "unknown", "id_number", "TD-1"), A("D-F", "applicant", "id_number", "TD-1"),
    ]);
    assert.equal(r.entities.length, 2);
    assert.deepEqual(r.entities[0]?.basis, ["account_number exact match: AC-9 (S-1, S-2)"]);
    assert.equal(r.entities[0]?.role, "account_holder");
    assert.equal(r.entities[1]?.role, "applicant");
  });
  it("a party with two different id_numbers uses the most confident one and cannot bridge two people", () => {
    const r = resolveEntities([
      A("D-A", "unknown", "id_number", "TD-1", 0.95), A("D-A", "unknown", "id_number", "TD-2", 0.5),
      A("D-B", "unknown", "id_number", "TD-1"), A("D-C", "unknown", "id_number", "TD-2"),
    ]);
    assert.equal(r.entities.length, 2);
    assert.ok(byId(r, "D-A") === byId(r, "D-B"));
    assert.ok(byId(r, "D-C") !== byId(r, "D-A"));
  });
  it("an OCR typo inside an id_number keeps the people separate and is not suggested", () => {
    const r = resolveEntities([
      A("D-A", "unknown", "full_name", "Aarav Sharma"), A("D-A", "unknown", "id_number", "TD-48213-77"),
      A("D-B", "applicant", "full_name", "Aarav Sharma"), A("D-B", "applicant", "id_number", "TD-48213-71"),
    ]);
    assert.equal(r.entities.length, 2);
    assert.ok(r.entities.every((e) => e.resolution === "UNRESOLVED" && !e.suggestedLinks));
  });
  it("null and empty identifiers are ignored", () => {
    const r = resolveEntities([A("D-A", "unknown", "id_number", null), A("D-B", "unknown", "id_number", null), A("D-C", "unknown", "id_number", "  ")]);
    assert.equal(r.entities.length, 3);
  });
});

describe("suggestions", () => {
  it("a name matching several entities is not suggested", () => {
    const r = resolveEntities([
      A("D-A", "applicant", "full_name", "Ravi Kumar"), A("D-A", "applicant", "id_number", "TD-1"),
      A("D-B", "unknown", "full_name", "Ravi Kumar"), A("D-B", "unknown", "id_number", "TD-1"),
      A("D-C", "co_applicant", "full_name", "Ravi Kumar"), A("D-C", "co_applicant", "id_number", "TD-9"),
      A("D-D", "co_applicant", "full_name", "Ravi Kumar"), A("D-D", "co_applicant", "id_number", "TD-9"),
      A("S-1", "account_holder", "full_name", "Ravi Kumar"), A("S-1", "account_holder", "account_number", "AC-5"),
    ]);
    const s = r.entities.find((e) => e.assertionIds.some((id) => id.startsWith("S-1")))!;
    assert.equal(s.resolution, "UNRESOLVED");
    assert.ok(s.basis.some((b) => /matches several entities \(E-001, E-002\)/.test(b)));
  });
  it("a suggestion needs a name match at or above the threshold", () => {
    const close = resolveEntities([A("D-A", "applicant", "id_number", "TD-1"), A("D-A", "applicant", "full_name", "Aarav Kumar Sharma"), A("D-A2", "applicant", "id_number", "TD-1"),
                                   A("S-1", "account_holder", "full_name", "Aarav Kumar Sharma")]);
    assert.equal(close.entities[1]?.resolution, "SUGGESTED");
    const far = resolveEntities([A("D-A", "applicant", "id_number", "TD-1"), A("D-A", "applicant", "full_name", "Aarav Kumar Sharma"), A("D-A2", "applicant", "id_number", "TD-1"),
                                 A("S-1", "account_holder", "full_name", "Aarav Sharma")]); // ratio 80
    assert.equal(far.entities[1]?.resolution, "UNRESOLVED");
  });
  it("a missing name never produces a suggestion", () => {
    const r = resolveEntities([A("D-A", "unknown", "dob", "2000-01-01"), A("D-B", "unknown", "dob", "2000-01-01")]);
    assert.ok(r.entities.every((e) => e.resolution === "UNRESOLVED"));
  });
});

describe("contract of the function", () => {
  it("empty input", () => assert.deepEqual(resolveEntities([]), { entities: [], assertions: [] }));
  it("keeps assertion order and numbers entities by first appearance", () => {
    const input = [A("D-B", "unknown", "id_number", "TD-2"), A("D-A", "unknown", "id_number", "TD-1"), A("D-B2", "unknown", "id_number", "TD-2")];
    const r = resolveEntities(input);
    assert.deepEqual(r.assertions.map((a) => a.assertionId), input.map((a) => a.assertionId));
    assert.deepEqual(r.assertions.map((a) => a.entityId), ["E-001", "E-002", "E-001"]);
  });
  it("is deterministic and never mutates or aliases its input", () => {
    const input = deepFreeze([A("D-A", "applicant", "id_number", "TD-1"), A("D-B", "unknown", "id_number", "TD-1"), A("S-1", "account_holder", "full_name", "X Y")]);
    assert.deepStrictEqual(resolveEntities(input), resolveEntities(input));
    const out = resolveEntities(input);
    out.assertions[0]!.region.bbox[0] = 0.9;
    assert.equal(input[0]!.region.bbox[0], 0.1);
    assert.ok(input.every((a) => a.entityId === null), "input entityId must stay null");
  });
  it("rejects assertions from more than one case", () => {
    const x = A("D-A", "unknown", "full_name", "A B");
    assert.throws(() => resolveEntities([x, { ...x, assertionId: "other", caseId: "OTHER" }]), /more than one case/);
  });
  it("every assertion gets exactly one entity and every entity lists only its assertions", () => {
    const docs = CASES["CASE-001"] ?? [];
    const a = docs.map((d) => readJson<AnalyzeResponse>(`analyze/${d}.json`));
    const r = resolveEntities(buildAssertions(a.flatMap((x) => x.fields), a.flatMap((x) => x.pages), "CASE-001"));
    assert.ok(r.assertions.every((x) => x.entityId !== null));
    const listed = r.entities.flatMap((e) => e.assertionIds);
    assert.equal(new Set(listed).size, listed.length);
    assert.equal(listed.length, r.assertions.length);
  });
});

describe("token-sort ratio", () => {
  it("matches the values used in the fixtures", () => {
    assert.equal(tokenSortRatio("Aarav Kumar Sharma", "Aarav Sharma"), 80);
    assert.equal(tokenSortRatio("Aarav Kumar Sharma", "AARAV KUMAR SHARMA"), 100);
    assert.equal(Math.round(tokenSortRatio("Priya Nair", "Priya Nayar") * 10) / 10, 85.7);
  });
  it("ignores token order, case and punctuation; empty is 0", () => {
    assert.equal(tokenSortRatio("Sharma, Aarav K.", "aarav k sharma"), 100);
    assert.equal(tokenSortRatio("", "x"), 0);
    assert.equal(tokenSortRatio("...", "x"), 0);
    assert.equal(bestNameRatio([], ["a"]), 0);
    assert.equal(bestNameRatio(["a b", "c d"], ["c d"]), 100);
  });
});
