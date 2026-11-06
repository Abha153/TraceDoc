import { describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import type { DocumentDetail, UploadResponse } from "@contracts/api";
import type { Job } from "@contracts/types";
import { FIXTURES_DIR, drain, loggedInAgent, testApp } from "./helpers.js";
import { HttpAnalysisClient } from "../src/services/httpAnalysisClient.js";

/**
 * Opt-in: runs the backend against a REAL analysis service (ocr-service). Skipped unless both variables are set:
 *   REAL_ANALYSIS_URL       where the service listens, e.g. http://127.0.0.1:8000
 *   REAL_ANALYSIS_DATA_DIR  the DATA_DIR the service was started with (the backend uses the same folder)
 * Use an empty folder: the tests create CASE-001 in it. See docs/ANALYSIS_INTEGRATION.md.
 *
 * The assertions hold whatever analyzers the service has registered (none, OCR only, or all), so they keep working as
 * Person 3's batches land. What they pin down is the boundary: contract-valid answers, honest statuses, real error mapping.
 */
const URL_ = process.env["REAL_ANALYSIS_URL"];
const DIR = process.env["REAL_ANALYSIS_DATA_DIR"];
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const INFRASTRUCTURE = /does not match contracts|value ranges|could not be reached|same DATA_DIR|did not answer/;

describe.skipIf(!URL_ || !DIR)("the real analysis service (opt-in)", () => {
  async function backend() {
    const t = await testApp({
      DATA_DIR: DIR!, ANALYSIS_MODE: "http", ANALYSIS_URL: URL_!, CONTRACTS_DIR: path.join(FIXTURES_DIR, ".."),
      JOB_RETRY_DELAY_MS: "0", ANALYSIS_RETRY_DELAY_MS: "0", JOB_TIMEOUT_MS: "120000", ANALYSIS_TIMEOUT_MS: "100000",
    });
    const agent = await loggedInAgent(t.app);
    await agent.post("/api/v1/cases").send({ title: "real service" }).expect(201);
    return { ...t, agent };
  }
  const original = (n: string) => readFile(path.join(FIXTURES_DIR, "originals", n));
  const job = async (agent: Awaited<ReturnType<typeof loggedInAgent>>, id: string) => (await agent.get(`/api/v1/jobs/${id}`).expect(200)).body as Job;

  it("is reachable", async () => {
    const t = await backend();
    expect(await (t.deps.analysisClient as HttpAnalysisClient).ping()).toMatchObject({ ok: true });
  });

  it("analyses a PNG and a PDF: contract-valid answers, real pages and renders, honest job statuses", async () => {
    const t = await backend();
    const up = (await t.agent.post("/api/v1/cases/CASE-001/documents")
      .attach("files", await original("D-01.png"), "id.png").attach("files", await original("D-03.pdf"), "statement.pdf").expect(202)).body as UploadResponse;
    await drain(t.deps, 100);
    for (const [i, d] of up.documents.entries()) {
      const j = await job(t.agent, up.jobs[i]!.jobId);
      expect(["DONE", "PARTIAL", "FAILED"]).toContain(j.status);
      // it must never fail because the answer was bad or the files were not shared
      expect(j.error ?? "").not.toMatch(INFRASTRUCTURE);
      // "no analyzers registered" is a FAILED job saying so, never a clean DONE
      if (Object.keys(j.analyzers).length === 0) expect(j).toMatchObject({ status: "FAILED", error: "the analysis service reported no analyzers, so nothing was analysed" });

      const detail = (await t.agent.get(`/api/v1/documents/${d.docId}`).expect(200)).body as DocumentDetail;
      expect(detail.pages.length).toBeGreaterThanOrEqual(1);
      expect(detail.document.pageCount).toBe(detail.pages.length);
      expect(detail.pages.every((p) => p.docId === d.docId && p.renderDpi > 0)).toBe(true);
      const render = await t.agent.get(`/api/v1/documents/${d.docId}/pages/1/render`).buffer(true).parse((r, cb) => {
        const c: Buffer[] = []; r.on("data", (x: Buffer) => c.push(x)); r.on("end", () => cb(null, Buffer.concat(c)));
      }).expect(200);
      expect((render.body as Buffer).subarray(0, 8)).toEqual(PNG_SIG);
    }
  });

  it("a PDF that cannot be opened is a permanent failure with the service's own reason (not retried)", async () => {
    const t = await backend();
    const up = (await t.agent.post("/api/v1/cases/CASE-001/documents")
      .attach("files", Buffer.from("%PDF-1.4\nthis is not a real pdf\n%%EOF\n"), "junk.pdf").expect(202)).body as UploadResponse;
    await drain(t.deps);
    const j = await job(t.agent, up.jobs[0]!.jobId);
    expect(j).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(j.error).toMatch(/rejected .* \(HTTP 415\)/);
  });

  it("an original the service cannot find (storage not shared) is a permanent failure that names DATA_DIR", async () => {
    const t = await backend();
    const up = (await t.agent.post("/api/v1/cases/CASE-001/documents").attach("files", await original("D-01.png"), "id.png").expect(202)).body as UploadResponse;
    await drain(t.deps);
    const docId = up.documents[0]!.docId;
    await rm(t.deps.storage.originalAbsPath(docId, "png"), { force: true });
    await t.agent.patch(`/api/v1/documents/${docId}/pages/1/type`).send({ docType: "other" }).expect(202); // forces a re-run
    await drain(t.deps);
    const jobs = (await t.agent.get("/api/v1/cases/CASE-001").expect(200)).body.jobs as Job[];
    const rerun = jobs.filter((x) => x.docId === docId).at(-1)!;
    expect(rerun).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(rerun.error).toMatch(/same DATA_DIR/);
    // the integrity check reports the same missing file
    const integrity = (await t.agent.get("/api/v1/cases/CASE-001/integrity").expect(200)).body;
    expect(integrity.status).toBe("FAIL");
  });
});
