import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import type { RelatedCasesResponse } from "@contracts/api";
import { FIXTURES_DIR, drain, loggedInAgent, testApp } from "./helpers.js";

const original = (name: string) => readFile(path.join(FIXTURES_DIR, "originals", name));

async function twoCases(files: [string[], string[]]) {
  const t = await testApp();
  const agent = await loggedInAgent(t.app);
  for (const title of ["First", "Second"]) await agent.post("/api/v1/cases").send({ title }).expect(201);
  for (const [i, names] of files.entries()) {
    const post = agent.post(`/api/v1/cases/CASE-00${i + 1}/documents`);
    for (const n of names) post.attach("files", await original(n), n);
    await post.expect(202);
    await drain(t.deps);
  }
  return agent;
}

describe("GET /cases/:caseId/related", () => {
  it("requires login", async () => {
    const { app } = await testApp();
    expect((await request(app).get("/api/v1/cases/CASE-001/related")).status).toBe(401);
  });

  it("404 for a missing case", async () => {
    const { app } = await testApp();
    const agent = await loggedInAgent(app);
    await agent.get("/api/v1/cases/CASE-099/related").expect(404);
  });

  it("finds the same file and the same id_number when one original is filed under two cases", async () => {
    const agent = await twoCases([["D-01.png"], ["D-01.png"]]);
    const body = (await agent.get("/api/v1/cases/CASE-001/related").expect(200)).body as RelatedCasesResponse;
    expect(body.related.map((r) => r.caseId)).toEqual(["CASE-002"]);
    const kinds = body.related[0]!.shared.map((s) => s.kind + ":" + (s.semanticType ?? ""));
    expect(kinds).toContain("file_hash:");
    expect(kinds).toContain("identifier:id_number");
    expect(body.basis).toContain("does not indicate wrongdoing");
    // symmetric from the other case
    const back = (await agent.get("/api/v1/cases/CASE-002/related").expect(200)).body as RelatedCasesResponse;
    expect(back.related.map((r) => r.caseId)).toEqual(["CASE-001"]);
  });

  it("reports nothing for two cases that share no strong identifier or file", async () => {
    const agent = await twoCases([["D-01.png"], ["D-11.png"]]);
    const body = (await agent.get("/api/v1/cases/CASE-001/related").expect(200)).body as RelatedCasesResponse;
    expect(body.related).toEqual([]);
  });

  it("does not change the case priority or findings (it is a lead, not a finding)", async () => {
    const agent = await twoCases([["D-01.png"], ["D-01.png"]]);
    const before = (await agent.get("/api/v1/cases/CASE-001/findings").expect(200)).body;
    await agent.get("/api/v1/cases/CASE-001/related").expect(200);
    expect((await agent.get("/api/v1/cases/CASE-001/findings").expect(200)).body).toEqual(before);
  });
});
