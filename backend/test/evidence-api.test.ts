import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import type { ReasoningOutput } from "@contracts/reasoning";
import type { CaseFixture, CaseSummary, FindingDetail, FindingsResponse, GraphResponse } from "@contracts/api";
import type { InvestigationEvent, ReviewStatus } from "@contracts/types";
import {
  FIXTURES_DIR, expectMatchesContract, fixtureJson, loggedInAgent, storeFixtureReasoning, testApp, uploadFixtureDocs,
} from "./helpers.js";
import { remapIds } from "../src/services/remap.js";
import type { ReviewSource } from "../src/services/reviewSource.js";

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** CASE-001 fully loaded: three uploads analysed by the mock, reasoning output stored. */
async function loadedCase001(depOverrides = {}) {
  const t = await testApp({}, depOverrides);
  const agent = await loggedInAgent(t.app);
  await agent.post("/api/v1/cases").send({ title: "Fixture case 1" }).expect(201);
  const mapping = await uploadFixtureDocs(t.deps, agent, "CASE-001", ["D-01.png", "D-02.png", "D-03.pdf"]);
  await storeFixtureReasoning(t.deps, "CASE-001", mapping);
  return { ...t, agent, mapping };
}

describe("auth", () => {
  it.each([
    "/api/v1/cases/CASE-001/findings",
    "/api/v1/findings/CASE-001-g1-F-0001",
    "/api/v1/cases/CASE-001/assertions",
    "/api/v1/cases/CASE-001/entities",
    "/api/v1/cases/CASE-001/graph",
    "/api/v1/documents/D-a/pages/1/render",
  ])("GET %s needs login", async (url) => {
    const { app } = await testApp();
    expect((await request(app).get(url)).status).toBe(401);
  });
});

describe("case with no reasoning run yet", () => {
  it("returns empty lists (not errors) and a null priority", async () => {
    const t = await testApp();
    const agent = await loggedInAgent(t.app);
    await agent.post("/api/v1/cases").send({ title: "Empty" }).expect(201);
    const findings = (await agent.get("/api/v1/cases/CASE-001/findings").expect(200)).body;
    expect(findings).toEqual({ caseId: "CASE-001", findings: [] });
    expectMatchesContract("FindingsResponse", findings);
    expect((await agent.get("/api/v1/cases/CASE-001/assertions").expect(200)).body).toEqual({ caseId: "CASE-001", assertions: [] });
    expect((await agent.get("/api/v1/cases/CASE-001/entities").expect(200)).body).toEqual({ caseId: "CASE-001", entities: [] });
    const summary = (await agent.get("/api/v1/cases/CASE-001").expect(200)).body as CaseSummary;
    expect(summary.priority).toBeNull();
  });

  it("404s an unknown case on every case route", async () => {
    const t = await testApp();
    const agent = await loggedInAgent(t.app);
    for (const r of ["findings", "assertions", "entities", "graph"]) {
      const res = await agent.get(`/api/v1/cases/CASE-404/${r}`).expect(404);
      expect(res.body.error.code).toBe("CASE_NOT_FOUND");
    }
  });
});

describe("CASE-001 read APIs return the fixture data and match the contracts", () => {
  it("GET /cases/:id/findings", async () => {
    const { agent } = await loadedCase001();
    const expected = await fixtureJson<ReasoningOutput>("CASE-001.reasoning.json");
    const res = await agent.get("/api/v1/cases/CASE-001/findings").expect(200);
    expectMatchesContract("FindingsResponse", res.body);
    const body = res.body as FindingsResponse;
    expect(body.findings.map((f) => f.finding.type)).toEqual(expected.findings.map((f) => f.type));
    expect(body.findings.map((f) => f.finding.findingId)).toEqual(expected.findings.map((f) => `CASE-001-g1-${f.findingId}`));
    expect(body.findings.every((f) => f.reviewStatus === "UNREVIEWED")).toBe(true);
    // machine output is passed through untouched
    const first = body.findings[0]!.finding;
    expect(first.observationStatus).toBe(expected.findings[0]!.observationStatus);
    expect(first.severity).toBe(expected.findings[0]!.severity);
    expect(first.confidence).toBe(expected.findings[0]!.confidence);
    expect(first.evidence[0]!.regions.length).toBeGreaterThan(0);
  });

  it("filters by category and observationStatus", async () => {
    const { agent } = await loadedCase001();
    const cat = (await agent.get("/api/v1/cases/CASE-001/findings?category=cross_document").expect(200)).body as FindingsResponse;
    expect(cat.findings.length).toBeGreaterThan(0);
    expect(cat.findings.every((f) => f.finding.category === "cross_document")).toBe(true);
    const obs = (await agent.get("/api/v1/cases/CASE-001/findings?observationStatus=POTENTIAL_ANOMALY").expect(200)).body as FindingsResponse;
    expect(obs.findings.map((f) => f.finding.type).sort()).toEqual(["REGION_EVENT", "TEXT_LAYER_MISMATCH"]);
    const both = (await agent.get("/api/v1/cases/CASE-001/findings?category=visual&observationStatus=POTENTIAL_ANOMALY").expect(200)).body as FindingsResponse;
    expect(both.findings.map((f) => f.finding.type)).toEqual(["REGION_EVENT"]);
  });

  it("rejects an unknown filter value or key with 400", async () => {
    const { agent } = await loadedCase001();
    await agent.get("/api/v1/cases/CASE-001/findings?category=nope").expect(400);
    await agent.get("/api/v1/cases/CASE-001/findings?reviewStatus=MAYBE").expect(400);
    await agent.get("/api/v1/cases/CASE-001/findings?severity=high").expect(400);
  });

  it("filters by review status through the review source (B9 plugs the event log in here)", async () => {
    const statuses: Record<string, ReviewStatus> = { "CASE-001-g1-F-0001": "CONFIRMED", "CASE-001-g1-F-0002": "DISMISSED" };
    const reviews: ReviewSource = { statusOf: async (id) => statuses[id] ?? "UNREVIEWED", historyOf: async () => [] };
    const { agent } = await loadedCase001({ reviews });
    const confirmed = (await agent.get("/api/v1/cases/CASE-001/findings?reviewStatus=CONFIRMED").expect(200)).body as FindingsResponse;
    expect(confirmed.findings.map((f) => f.finding.findingId)).toEqual(["CASE-001-g1-F-0001"]);
    const unreviewed = (await agent.get("/api/v1/cases/CASE-001/findings?reviewStatus=UNREVIEWED").expect(200)).body as FindingsResponse;
    expect(unreviewed.findings).toHaveLength(4);
    const all = (await agent.get("/api/v1/cases/CASE-001/findings").expect(200)).body as FindingsResponse;
    expect(all.findings.find((f) => f.finding.findingId === "CASE-001-g1-F-0002")!.reviewStatus).toBe("DISMISSED");
  });

  it("GET /findings/:id returns the finding, its evidence and the review history", async () => {
    const event: InvestigationEvent = {
      eventId: "IE-001", caseId: "CASE-001", at: "2026-11-01T09:30:00Z", actor: "analyst", type: "REVIEW",
      targetId: "CASE-001-g1-F-0001", payload: { status: "CONFIRMED" },
    };
    const reviews: ReviewSource = { statusOf: async () => "CONFIRMED", historyOf: async () => [event] };
    const { agent } = await loadedCase001({ reviews });
    const res = await agent.get("/api/v1/findings/CASE-001-g1-F-0001").expect(200);
    expectMatchesContract("FindingDetail", res.body);
    const body = res.body as FindingDetail;
    expect(body.finding).toMatchObject({ type: "DOB_CONFLICT", severity: "high", observationStatus: "INCONSISTENT" });
    expect(body.finding.evidence[0]!.regions).toHaveLength(2);
    expect(body.reviewStatus).toBe("CONFIRMED");
    expect(body.reviewHistory).toEqual([event]);
  });

  it("GET /findings/:id 404s unknown ids and rejects malformed ones", async () => {
    const { agent } = await loadedCase001();
    expect((await agent.get("/api/v1/findings/CASE-001-g1-F-9999").expect(404)).body.error.code).toBe("FINDING_NOT_FOUND");
    expect((await agent.get("/api/v1/findings/F-0001").expect(404)).body.error.code).toBe("FINDING_NOT_FOUND");
    await agent.get("/api/v1/findings/.hidden").expect(400);
  });

  it("GET /cases/:id/assertions and /entities", async () => {
    const { agent, mapping } = await loadedCase001();
    const expected = remapIds(await fixtureJson<ReasoningOutput>("CASE-001.reasoning.json"), mapping);
    const a = await agent.get("/api/v1/cases/CASE-001/assertions").expect(200);
    expectMatchesContract("AssertionsResponse", a.body);
    expect(a.body.assertions).toEqual(expected.assertions);
    expect(JSON.stringify(a.body)).not.toMatch(/"D-0[123]"/); // fixture ids were re-labelled
    const e = await agent.get("/api/v1/cases/CASE-001/entities").expect(200);
    expectMatchesContract("EntitiesResponse", e.body);
    expect(e.body.entities).toEqual(expected.entities);
    expect(e.body.entities.map((x: { resolution: string }) => x.resolution)).toEqual(["RESOLVED", "SUGGESTED"]);
  });

  it("GET /cases/:id/graph equals the fixture graph (re-labelled)", async () => {
    const { agent, mapping } = await loadedCase001();
    const ids: Record<string, string> = { ...mapping };
    for (let n = 1; n <= 6; n++) ids[`F-000${n}`] = `CASE-001-g1-F-000${n}`;
    const expected = remapIds(await fixtureJson<GraphResponse>("CASE-001.graph.json"), ids);
    const res = await agent.get("/api/v1/cases/CASE-001/graph").expect(200);
    expectMatchesContract("GraphResponse", res.body);
    expect(res.body).toEqual(expected);
    expect((res.body as GraphResponse).edges.filter((e) => e.kind === "conflict")).toHaveLength(3);
  });

  it("the case summary carries the stored priority, per case and per document", async () => {
    const { agent, mapping } = await loadedCase001();
    const expected = await fixtureJson<ReasoningOutput>("CASE-001.reasoning.json");
    const s = (await agent.get("/api/v1/cases/CASE-001").expect(200)).body as CaseSummary;
    expect(s.priority).toMatchObject({ priorityBand: expected.priority.perCase.priorityBand, score: expected.priority.perCase.score });
    expect(s.priority!.contributingFindingIds.every((id) => id.startsWith("CASE-001-g1-"))).toBe(true);
    expect(Object.keys(s.perDocumentPriority).sort()).toEqual(Object.values(mapping).sort());
  });

  it("a second reasoning run replaces the lists but old finding ids remain readable", async () => {
    const { agent, deps, mapping } = await loadedCase001();
    await storeFixtureReasoning(deps, "CASE-001", mapping); // generation 2
    const list = (await agent.get("/api/v1/cases/CASE-001/findings").expect(200)).body as FindingsResponse;
    expect(list.findings[0]!.finding.findingId).toBe("CASE-001-g2-F-0001");
    expect(list.findings).toHaveLength(6); // latest generation only, not 12
    await agent.get("/api/v1/findings/CASE-001-g1-F-0001").expect(200);
    await agent.get("/api/v1/findings/CASE-001-g2-F-0001").expect(200);
  });
});

describe("CASE-002 (similar names, different people)", () => {
  it("keeps two entities apart and has no findings or conflict edges", async () => {
    const t = await testApp();
    const agent = await loggedInAgent(t.app);
    await agent.post("/api/v1/cases").send({ title: "one" }).expect(201);
    await agent.post("/api/v1/cases").send({ title: "two" }).expect(201);
    const mapping = await uploadFixtureDocs(t.deps, agent, "CASE-002", ["D-11.png", "D-12.png", "D-13.png"]);
    await storeFixtureReasoning(t.deps, "CASE-002", mapping);

    const ents = (await agent.get("/api/v1/cases/CASE-002/entities").expect(200)).body;
    expectMatchesContract("EntitiesResponse", ents);
    expect(ents.entities.map((e: { role: string }) => e.role)).toEqual(["applicant", "guarantor"]);
    expect((await agent.get("/api/v1/cases/CASE-002/findings").expect(200)).body.findings).toEqual([]);

    const g = (await agent.get("/api/v1/cases/CASE-002/graph").expect(200)).body as GraphResponse;
    expectMatchesContract("GraphResponse", g);
    expect(g.edges.some((e) => e.kind === "conflict")).toBe(false);
    expect(g).toEqual(remapIds(await fixtureJson<GraphResponse>("CASE-002.graph.json"), mapping));
    // the other case is untouched
    expect((await agent.get("/api/v1/cases/CASE-001/entities").expect(200)).body.entities).toEqual([]);
  });
});

describe("GET /documents/:docId/pages/:n/render", () => {
  async function uploaded() {
    const t = await testApp();
    const agent = await loggedInAgent(t.app);
    await agent.post("/api/v1/cases").send({ title: "r" }).expect(201);
    const mapping = await uploadFixtureDocs(t.deps, agent, "CASE-001", ["D-01.png", "D-03.pdf"]);
    return { ...t, agent, mapping };
  }

  it("serves the canonical page render as a PNG", async () => {
    const { agent, mapping } = await uploaded();
    const res = await agent.get(`/api/v1/documents/${mapping["D-01"]}/pages/1/render`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(res.headers["content-type"]).toMatch(/image\/png/);
    expect((res.body as Buffer).subarray(0, 8)).toEqual(PNG_SIG);
    expect(res.body).toEqual(await readFile(path.join(FIXTURES_DIR, "pages", "D-01-page-1.png")));
  });

  it("404s a page the document does not have, and validates the page number", async () => {
    const { agent, mapping } = await uploaded();
    const d = mapping["D-01"];
    expect((await agent.get(`/api/v1/documents/${d}/pages/2/render`).expect(404)).body.error.code).toBe("PAGE_NOT_FOUND");
    await agent.get(`/api/v1/documents/${d}/pages/0/render`).expect(400);
    await agent.get(`/api/v1/documents/${d}/pages/abc/render`).expect(400);
    await agent.get(`/api/v1/documents/${d}/pages/1.5/render`).expect(400);
  });

  it("404s unknown documents and rejects path tricks", async () => {
    const { agent } = await uploaded();
    expect((await agent.get("/api/v1/documents/D-nope/pages/1/render").expect(404)).body.error.code).toBe("DOCUMENT_NOT_FOUND");
    expect([400, 404]).toContain((await agent.get("/api/v1/documents/..%2F..%2Fetc/pages/1/render")).status);
  });

  it("says so when the file is missing, and for a document that was never analysed", async () => {
    const { agent, deps, mapping } = await uploaded();
    const { rm } = await import("node:fs/promises");
    await rm(deps.storage.derivedFile(mapping["D-03"]!, "page-1.png"));
    expect((await agent.get(`/api/v1/documents/${mapping["D-03"]}/pages/1/render`).expect(404)).body.error.code).toBe("RENDER_NOT_FOUND");

    // a PDF with no recorded analysis: uploaded, job FAILED, no pages
    const up = await agent.post("/api/v1/cases/CASE-001/documents").attach("files", Buffer.from("%PDF-1.4\n%%EOF"), "x.pdf").expect(202);
    const { drain } = await import("./helpers.js");
    await drain(deps);
    expect((await agent.get(`/api/v1/documents/${up.body.documents[0].docId}/pages/1/render`).expect(404)).body.error.code).toBe("PAGE_NOT_FOUND");
  });
});

describe("fixtures sanity", () => {
  it("case fixtures list the documents the tests upload", async () => {
    const fx = await fixtureJson<CaseFixture>("CASE-001.case.json");
    expect(fx.documents.map((d) => d.docId)).toEqual(["D-01", "D-02", "D-03"]);
  });
});
