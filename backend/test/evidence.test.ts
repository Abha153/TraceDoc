import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ReasoningOutput } from "@contracts/reasoning";
import type { CaseFixture } from "@contracts/api";
import type { AnalyzeResponse } from "@contracts/types";
import { JsonEvidenceRepository, namespaceFindingId, parseFindingId } from "../src/repo/evidence.js";
import { buildGraph } from "../src/services/graph.js";
import { fixtureJson } from "./helpers.js";

const sha = async (f: string) => createHash("sha256").update(await readFile(f)).digest("hex");

async function repo() {
  const dir = await mkdtemp(path.join(tmpdir(), "td-evidence-"));
  return { dir, repo: new JsonEvidenceRepository(dir, () => new Date("2026-11-01T09:00:00Z")) };
}

describe("evidence store generations", () => {
  it("writes generation 1 with namespaced finding ids, and keeps everything else as produced", async () => {
    const out = await fixtureJson<ReasoningOutput>("CASE-001.reasoning.json");
    const { repo: r } = await repo();
    const rec = await r.put("CASE-001", out, []);
    expect(rec.generation).toBe(1);
    expect(rec.createdAt).toBe("2026-11-01T09:00:00.000Z");
    expect(rec.findings.map((f) => f.findingId)).toEqual(out.findings.map((f) => `CASE-001-g1-${f.findingId}`));
    // only the id changed
    expect(rec.findings.map(({ findingId: _a, ...rest }) => rest)).toEqual(out.findings.map(({ findingId: _b, ...rest }) => rest));
    expect(rec.assertions).toEqual(out.assertions);
    expect(rec.entities).toEqual(out.entities);
    expect(rec.events).toEqual(out.events);
    // priority still points at the (renamed) findings
    expect(rec.priority.perCase.contributingFindingIds).toEqual(out.priority.perCase.contributingFindingIds.map((id) => `CASE-001-g1-${id}`));
    expect(rec.priority.perCase.score).toBe(out.priority.perCase.score);
  });

  it("a re-run writes generation 2 and leaves generation 1 byte-for-byte unchanged", async () => {
    const out = await fixtureJson<ReasoningOutput>("CASE-001.reasoning.json");
    const { dir, repo: r } = await repo();
    await r.put("CASE-001", out, []);
    const file1 = path.join(dir, "evidence", "CASE-001", "gen-0001.json");
    const before = await sha(file1);

    const changed: ReasoningOutput = { ...out, findings: out.findings.slice(0, 2) };
    const rec2 = await r.put("CASE-001", changed, []);
    expect(rec2.generation).toBe(2);
    expect(await sha(file1)).toBe(before);
    expect((await readdir(path.join(dir, "evidence", "CASE-001"))).sort()).toEqual(["gen-0001.json", "gen-0002.json"]);

    expect((await r.latest("CASE-001"))!.generation).toBe(2);
    expect((await r.get("CASE-001", 1))!.findings).toHaveLength(out.findings.length);
    expect(await r.generations("CASE-001")).toEqual([
      { generation: 1, createdAt: "2026-11-01T09:00:00.000Z", findingCount: out.findings.length },
      { generation: 2, createdAt: "2026-11-01T09:00:00.000Z", findingCount: 2 },
    ]);
  });

  it("old findings stay addressable after a re-run, and say they are not the latest", async () => {
    const out = await fixtureJson<ReasoningOutput>("CASE-001.reasoning.json");
    const { repo: r } = await repo();
    await r.put("CASE-001", out, []);
    await r.put("CASE-001", out, []);
    const old = (await r.findFinding("CASE-001-g1-F-0001"))!;
    const now = (await r.findFinding("CASE-001-g2-F-0001"))!;
    expect(old.isLatest).toBe(false);
    expect(now.isLatest).toBe(true);
    expect(old.finding.findingId).not.toBe(now.finding.findingId);
    expect(old.finding.type).toBe(now.finding.type);
  });

  it("generations are read-only files, and concurrent writers get distinct generations", async () => {
    const out = await fixtureJson<ReasoningOutput>("CASE-001.reasoning.json");
    const { dir, repo: r } = await repo();
    const recs = await Promise.all([r.put("CASE-001", out, []), r.put("CASE-001", out, []), r.put("CASE-001", out, [])]);
    expect(recs.map((x) => x.generation).sort()).toEqual([1, 2, 3]);
    for (const n of [1, 2, 3]) {
      expect((await stat(path.join(dir, "evidence", "CASE-001", `gen-000${n}.json`))).mode & 0o222).toBe(0);
    }
    // no temp files left behind
    expect((await readdir(path.join(dir, "evidence", "CASE-001"))).every((f) => /^gen-\d{4}\.json$/.test(f))).toBe(true);
  });

  it("cases are isolated, and unknown lookups return undefined", async () => {
    const out = await fixtureJson<ReasoningOutput>("CASE-001.reasoning.json");
    const { repo: r } = await repo();
    await r.put("CASE-001", out, []);
    expect(await r.latest("CASE-002")).toBeUndefined();
    expect(await r.generations("CASE-002")).toEqual([]);
    expect(await r.findFinding("CASE-001-g9-F-0001")).toBeUndefined();
    expect(await r.findFinding("CASE-001-g1-F-9999")).toBeUndefined();
    expect(await r.findFinding("not-a-finding-id")).toBeUndefined();
    await expect(r.latest("../evil")).rejects.toMatchObject({ code: "INVALID_ID" });
  });

  it("stores signals with the generation", async () => {
    const out = await fixtureJson<ReasoningOutput>("CASE-001.reasoning.json");
    const d2 = await fixtureJson<AnalyzeResponse>("analyze/D-02.json");
    const { repo: r } = await repo();
    await r.put("CASE-001", out, d2.signals);
    expect((await r.latest("CASE-001"))!.signals).toEqual(d2.signals);
  });
});

describe("finding id helpers", () => {
  it("round-trips", () => {
    const id = namespaceFindingId("CASE-001", 3, "F-0007");
    expect(id).toBe("CASE-001-g3-F-0007");
    expect(parseFindingId(id)).toEqual({ caseId: "CASE-001", generation: 3 });
    expect(parseFindingId("F-0007")).toBeUndefined();
  });
});

describe("buildGraph reproduces the fixture graphs", () => {
  it.each(["CASE-001", "CASE-002"])("%s", async (caseId) => {
    const reasoning = await fixtureJson<ReasoningOutput>(`${caseId}.reasoning.json`);
    const fx = await fixtureJson<CaseFixture>(`${caseId}.case.json`);
    const expected = await fixtureJson<unknown>(`${caseId}.graph.json`);
    const docTypes: Record<string, never> = {};
    const fieldNames: Record<string, string> = {};
    for (const d of fx.documents) {
      const a = await fixtureJson<AnalyzeResponse>(`analyze/${d.docId}.json`);
      (docTypes as Record<string, unknown>)[d.docId] = a.pages[0]!.docType;
      for (const f of a.fields) fieldNames[f.fieldId] = f.name;
    }
    const graph = buildGraph({
      caseId, documents: fx.documents, docTypes, fieldNames,
      assertions: reasoning.assertions, entities: reasoning.entities, findings: reasoning.findings,
    });
    expect(graph).toEqual(expected);
  });

  it("without evidence the graph has the documents and no edges", async () => {
    const fx = await fixtureJson<CaseFixture>("CASE-001.case.json");
    const g = buildGraph({ caseId: "CASE-001", documents: fx.documents, docTypes: {}, fieldNames: {}, assertions: [], entities: [], findings: [] });
    expect(g.nodes.map((n) => n.id)).toEqual(["D-01", "D-02", "D-03"]);
    expect(g.nodes[0]).toEqual({ id: "D-01", kind: "document", label: "D-01" });
    expect(g.edges).toEqual([]);
  });
});
