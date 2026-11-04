import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CORRELATION_BASIS, correlateCases, type CorrelationCase } from "./correlation";

const A = (assertionId: string, docId: string, semanticType: string, normalizedValue: string | null) => ({ assertionId, docId, semanticType, normalizedValue });
const caseOf = (caseId: string, assertions: CorrelationCase["assertions"], documents: CorrelationCase["documents"] = []): CorrelationCase => ({ caseId, title: `Title ${caseId}`, assertions, documents });

describe("correlateCases", () => {
  it("links two cases that share an id_number, with refs on both sides", () => {
    const cur = caseOf("C1", [A("A1", "D1", "id_number", "XQ123"), A("A2", "D1", "full_name", "asha rao")]);
    const oth = caseOf("C2", [A("B1", "D9", "id_number", "XQ123")]);
    const r = correlateCases(cur, [oth]);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.caseId, "C2");
    assert.deepEqual(r[0]!.shared, [{ kind: "identifier", semanticType: "id_number", value: "XQ123", thisCase: [{ docId: "D1", assertionId: "A1" }], otherCase: [{ docId: "D9", assertionId: "B1" }] }]);
  });

  it("never correlates names, addresses, dates or amounts", () => {
    const cur = caseOf("C1", [A("A1", "D1", "full_name", "asha rao"), A("A2", "D1", "address_permanent", "1 main st"), A("A3", "D1", "dob", "2001-08-12"), A("A4", "D1", "requested_amount", "50000")]);
    const oth = caseOf("C2", [A("B1", "D9", "full_name", "asha rao"), A("B2", "D9", "address_permanent", "1 main st"), A("B3", "D9", "dob", "2001-08-12"), A("B4", "D9", "requested_amount", "50000")]);
    assert.deepEqual(correlateCases(cur, [oth]), []);
  });

  it("does not match an id_number against an account_number with the same value", () => {
    const cur = caseOf("C1", [A("A1", "D1", "id_number", "12345678")]);
    const oth = caseOf("C2", [A("B1", "D9", "account_number", "12345678")]);
    assert.deepEqual(correlateCases(cur, [oth]), []);
  });

  it("ignores null identifiers and never matches two missing values", () => {
    const cur = caseOf("C1", [A("A1", "D1", "id_number", null)]);
    const oth = caseOf("C2", [A("B1", "D9", "id_number", null)]);
    assert.deepEqual(correlateCases(cur, [oth]), []);
  });

  it("matches identical files by hash and reports no assertion id", () => {
    const sha = "ab".repeat(32);
    const r = correlateCases(caseOf("C1", [], [{ docId: "D1", sha256: sha }]), [caseOf("C2", [], [{ docId: "D7", sha256: sha }, { docId: "D8", sha256: "cd".repeat(32) }])]);
    assert.equal(r.length, 1);
    assert.deepEqual(r[0]!.shared[0], { kind: "file_hash", value: sha, thisCase: [{ docId: "D1" }], otherCase: [{ docId: "D7" }] });
  });

  it("never links a case to itself and orders cases by number of shared values, then id", () => {
    const cur = caseOf("C1", [A("A1", "D1", "id_number", "X1"), A("A2", "D1", "account_number", "9999")]);
    const one = caseOf("C3", [A("B1", "D3", "id_number", "X1")]);
    const two = caseOf("C2", [A("B2", "D2", "id_number", "X1"), A("B3", "D2", "account_number", "9999")]);
    const r = correlateCases(cur, [cur, one, two]);
    assert.deepEqual(r.map((x) => [x.caseId, x.shared.length]), [["C2", 2], ["C3", 1]]);
  });

  it("is deterministic and does not mutate its input", () => {
    const cur = Object.freeze(caseOf("C1", [A("A2", "D1", "id_number", "X1"), A("A1", "D2", "id_number", "X1")]));
    const oth = Object.freeze(caseOf("C2", [A("B1", "D9", "id_number", "X1")]));
    assert.deepEqual(correlateCases(cur, [oth]), correlateCases(cur, [oth]));
    assert.deepEqual(correlateCases(cur, [oth])[0]!.shared[0]!.thisCase.map((r) => r.docId), ["D1", "D2"]); // sorted by document, whatever the input order
  });

  it("states that a match is a lead and not wrongdoing", () => {
    assert.match(CORRELATION_BASIS, /does not indicate wrongdoing/);
  });
});
