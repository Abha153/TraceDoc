import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import type { CaseSummary, DocumentDetail, UploadResponse, Case } from "@contracts/api";
import type { Job } from "@contracts/types";
import { FIXTURES_DIR, PDF_BYTES, drain, loggedInAgent, testApp } from "./helpers.js";
import { remapId } from "../src/services/remap.js";

const original = (name: string) => readFile(path.join(FIXTURES_DIR, "originals", name));

describe("auth is required everywhere", () => {
  it.each([
    ["get", "/api/v1/cases"],
    ["post", "/api/v1/cases"],
    ["get", "/api/v1/cases/CASE-001"],
    ["post", "/api/v1/cases/CASE-001/documents"],
    ["get", "/api/v1/documents/D-a"],
    ["get", "/api/v1/jobs/JOB-0001"],
  ] as const)("%s %s -> 401", async (method, url) => {
    const { app } = await testApp();
    expect((await request(app)[method](url)).status).toBe(401);
  });
});

describe("cases", () => {
  it("creates sequential cases and lists them as summaries", async () => {
    const { app } = await testApp();
    const agent = await loggedInAgent(app);
    const a = await agent.post("/api/v1/cases").send({ title: "First" }).expect(201);
    const b = await agent.post("/api/v1/cases").send({ title: "Second" }).expect(201);
    expect((a.body as Case).caseId).toBe("CASE-001");
    expect(b.body.caseId).toBe("CASE-002");
    expect(a.body).toMatchObject({ title: "First", createdBy: "analyst" });
    const list = (await agent.get("/api/v1/cases").expect(200)).body as CaseSummary[];
    expect(list.map((s) => s.case.caseId)).toEqual(["CASE-001", "CASE-002"]);
    expect(list[0]).toMatchObject({ documents: [], jobs: [], priority: null, perDocumentPriority: {} });
  });

  it("validates the title", async () => {
    const { app } = await testApp();
    const agent = await loggedInAgent(app);
    expect((await agent.post("/api/v1/cases").send({}).expect(400)).body.error.code).toBe("VALIDATION_ERROR");
    await agent.post("/api/v1/cases").send({ title: "   " }).expect(400);
    await agent.post("/api/v1/cases").send({ title: "x", extra: 1 }).expect(400);
  });

  it("404s an unknown case", async () => {
    const { app } = await testApp();
    const agent = await loggedInAgent(app);
    const res = await agent.get("/api/v1/cases/CASE-999").expect(404);
    expect(res.body.error.code).toBe("CASE_NOT_FOUND");
  });
});

describe("upload creates a job that completes via the mock client", () => {
  it("accepts a fixture original (202), then the worker finishes the job and the document has pages and fields", async () => {
    const { app, deps } = await testApp();
    const agent = await loggedInAgent(app);
    await agent.post("/api/v1/cases").send({ title: "Demo" }).expect(201);

    const up = await agent.post("/api/v1/cases/CASE-001/documents").attach("files", await original("D-01.png"), "id_card.png").expect(202);
    const body = up.body as UploadResponse;
    expect(body.caseId).toBe("CASE-001");
    expect(body.documents).toHaveLength(1);
    expect(body.documents[0]).toMatchObject({ caseId: "CASE-001", filename: "id_card.png", mimeType: "image/png", pageCount: 0, processing: {} });
    expect(body.jobs[0]).toMatchObject({ status: "QUEUED", docId: body.documents[0]!.docId, attempts: 0 });

    const jobId = body.jobs[0]!.jobId;
    expect(((await agent.get(`/api/v1/jobs/${jobId}`).expect(200)).body as Job).status).toBe("QUEUED");

    await drain(deps);
    const job = (await agent.get(`/api/v1/jobs/${jobId}`).expect(200)).body as Job;
    expect(job.status).toBe("DONE");
    expect(job.analyzers["ocr"]).toMatchObject({ state: "DONE", analyzerStatus: "AVAILABLE" });
    expect(job.analyzers["pdf.fonts"]).toMatchObject({ state: "NOT_APPLICABLE" });

    const docId = body.documents[0]!.docId;
    const detail = (await agent.get(`/api/v1/documents/${docId}`).expect(200)).body as DocumentDetail;
    expect(detail.document).toMatchObject({ docId, pageCount: 1 });
    expect(detail.document.processing["ocr"]).toBe("AVAILABLE");
    expect(detail.pages[0]).toMatchObject({ docId, page: 1, docType: "id_card" });
    expect(detail.fields.length).toBeGreaterThan(0);
    // every id inside the recorded response was re-labelled with the server-generated docId
    expect(JSON.stringify(detail)).not.toContain('"D-01"');
    expect(detail.fields.every((f) => f.docId === docId && f.region.docId === docId)).toBe(true);
  });

  it("D-02 finishes PARTIAL: its signature analyzer is UNAVAILABLE in the fixture, and the UI can see that", async () => {
    const { app, deps } = await testApp();
    const agent = await loggedInAgent(app);
    await agent.post("/api/v1/cases").send({ title: "Demo" });
    const up = (await agent.post("/api/v1/cases/CASE-001/documents").attach("files", await original("D-02.png"), "form.png").expect(202)).body as UploadResponse;
    await drain(deps);
    const job = (await agent.get(`/api/v1/jobs/${up.jobs[0]!.jobId}`).expect(200)).body as Job;
    expect(job.status).toBe("PARTIAL");
    expect(job.analyzers["signature"]).toMatchObject({ state: "UNAVAILABLE", analyzerStatus: "UNAVAILABLE" });
    const doc = (await agent.get(`/api/v1/documents/${up.documents[0]!.docId}`).expect(200)).body as DocumentDetail;
    expect(doc.document.processing["signature"]).toBe("UNAVAILABLE");
  });

  it("uploads every fixture original of both cases and every job ends DONE or PARTIAL", async () => {
    const { app, deps } = await testApp();
    const agent = await loggedInAgent(app);
    await agent.post("/api/v1/cases").send({ title: "One" });
    const names = (await readdir(path.join(FIXTURES_DIR, "originals"))).sort();
    const files = agent.post("/api/v1/cases/CASE-001/documents");
    for (const n of names) files.attach("files", await original(n), n);
    const up = (await files.expect(202)).body as UploadResponse;
    expect(up.jobs).toHaveLength(names.length);
    await drain(deps);
    for (const j of up.jobs) {
      const status = ((await agent.get(`/api/v1/jobs/${j.jobId}`)).body as Job).status;
      expect(["DONE", "PARTIAL"]).toContain(status);
    }
  });

  it("a file with no recorded analysis fails immediately and says why (never reported as clean)", async () => {
    const { app, deps } = await testApp();
    const agent = await loggedInAgent(app);
    await agent.post("/api/v1/cases").send({ title: "Demo" });
    const up = (await agent.post("/api/v1/cases/CASE-001/documents").attach("files", PDF_BYTES, "unknown.pdf").expect(202)).body as UploadResponse;
    await drain(deps);
    const job = (await agent.get(`/api/v1/jobs/${up.jobs[0]!.jobId}`)).body as Job;
    expect(job).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(job.error).toMatch(/no recorded result/);
    const doc = (await agent.get(`/api/v1/documents/${up.documents[0]!.docId}`).expect(200)).body as DocumentDetail;
    expect(doc.pages).toEqual([]);
    expect(doc.document.processing).toEqual({});
  });

  it("the case summary lists its documents and jobs", async () => {
    const { app, deps } = await testApp();
    const agent = await loggedInAgent(app);
    await agent.post("/api/v1/cases").send({ title: "Demo" });
    await agent.post("/api/v1/cases/CASE-001/documents").attach("files", await original("D-01.png"), "a.png").attach("files", await original("D-03.pdf"), "b.pdf").expect(202);
    await drain(deps);
    const s = (await agent.get("/api/v1/cases/CASE-001").expect(200)).body as CaseSummary;
    expect(s.documents.map((d) => d.mimeType)).toEqual(["image/png", "application/pdf"]);
    expect(s.jobs).toHaveLength(2);
    expect(s.documents.every((d) => d.pageCount > 0)).toBe(true);
    expect(s.priority).toBeNull();
  });
});

describe("upload guards", () => {
  it("404s an unknown case and stores nothing", async () => {
    const { app, config } = await testApp();
    const agent = await loggedInAgent(app);
    const res = await agent.post("/api/v1/cases/CASE-404/documents").attach("files", PDF_BYTES, "a.pdf");
    expect(res.status).toBe(404);
    await expect(readdir(path.join(config.dataDir, "evidence"))).rejects.toThrow();
  });

  it("a rejected file creates no document and no job", async () => {
    const { app, deps } = await testApp();
    const agent = await loggedInAgent(app);
    await agent.post("/api/v1/cases").send({ title: "Demo" });
    await agent.post("/api/v1/cases/CASE-001/documents").attach("files", Buffer.from("MZ not a document"), "x.pdf").expect(400);
    expect(await deps.jobs.list()).toEqual([]);
    expect(await deps.documents.listByCase("CASE-001")).toEqual([]);
  });

  it("404s unknown documents and jobs, and rejects malformed ids", async () => {
    const { app } = await testApp();
    const agent = await loggedInAgent(app);
    expect((await agent.get("/api/v1/documents/D-nope").expect(404)).body.error.code).toBe("DOCUMENT_NOT_FOUND");
    expect((await agent.get("/api/v1/jobs/JOB-0099").expect(404)).body.error.code).toBe("JOB_NOT_FOUND");
    await agent.get("/api/v1/jobs/..%2F..%2Fx").expect(400);
    await agent.get("/api/v1/documents/.hidden").expect(400);
  });
});

describe("remapId", () => {
  it("replaces whole ids including inside longer ids and paths, but not prefixes of other ids", () => {
    const v = { docId: "D-01", fieldId: "D-01-F01", path: "data/derived/D-01/page-1.png", other: "D-011", n: 1 };
    expect(remapId(v, "D-01", "D-abc")).toEqual({
      docId: "D-abc", fieldId: "D-abc-F01", path: "data/derived/D-abc/page-1.png", other: "D-011", n: 1,
    });
  });
});
