import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AnalyzeResponse, DocumentRecord, Job } from "@contracts/types";
import { JsonAnalysisRepository, JsonDocumentRepository, JsonJobRepository } from "../src/repo/repositories.js";
import { JobService } from "../src/services/jobs.js";
import { Worker } from "../src/services/worker.js";
import { PermanentAnalysisError, type AnalysisClient } from "../src/services/analysisClient.js";
import { createLogger } from "../src/logger.js";

const okResponse = (docId: string, statuses: AnalyzeResponse["analyzerStatuses"] = { ocr: "AVAILABLE" }): AnalyzeResponse => ({
  docId,
  pipelineVersion: "0.1.0",
  pages: [
    { docId, page: 1, renderPath: `data/derived/${docId}/page-1.png`, renderDpi: 150, rotationDeg: 0, deskewDeg: 0, docType: "id_card", docTypeConfidence: 0.9 },
  ],
  fields: [],
  signals: [],
  analyzerStatuses: statuses,
  provenance: [],
});

async function setup(client: AnalysisClient, over: { timeoutMs?: number; maxAttempts?: number } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "td-worker-"));
  const jobs = new JobService(new JsonJobRepository(dir), { pipelineVersion: "0.1.0", maxAttempts: over.maxAttempts ?? 3 });
  const analysis = new JsonAnalysisRepository(dir);
  const documents = new JsonDocumentRepository(dir);
  const worker = new Worker({
    jobs, client, analysis, documents, logger: createLogger("silent"),
    timeoutMs: over.timeoutMs ?? 1000, pollMs: 10, retryDelayMs: 0,
  });
  const record: DocumentRecord = {
    docId: "D-a", caseId: "CASE-001", filename: "a.png", sha256: "0".repeat(64), mimeType: "image/png",
    pageCount: 0, processing: {}, pipelineVersion: "0.1.0", receivedAt: "2026-11-01T09:00:00Z",
  };
  await documents.put(record);
  await jobs.enqueue({ caseId: "CASE-001", docId: "D-a" });
  return { jobs, analysis, documents, worker };
}

describe("Worker.processNext", () => {
  it("returns undefined when the queue is empty", async () => {
    const t = await setup({ analyze: async (d) => okResponse(d) });
    await t.worker.processNext();
    expect(await t.worker.processNext()).toBeUndefined();
  });

  it("stores the analysis, updates the document record and finishes the job", async () => {
    const t = await setup({ analyze: async (d) => okResponse(d, { ocr: "AVAILABLE", "pdf.fonts": "NOT_APPLICABLE" }) });
    const job = (await t.worker.processNext())!;
    expect(job.status).toBe("DONE");
    expect((await t.analysis.get("D-a"))!.pages).toHaveLength(1);
    expect(await t.documents.get("D-a")).toMatchObject({
      pageCount: 1,
      processing: { ocr: "AVAILABLE", "pdf.fonts": "NOT_APPLICABLE" },
    });
  });

  it("reports PARTIAL when an analyzer failed, and keeps the other results", async () => {
    const t = await setup({ analyze: async (d) => okResponse(d, { ocr: "AVAILABLE", "image.ela": "ERROR" }) });
    const job = (await t.worker.processNext())!;
    expect(job.status).toBe("PARTIAL");
    expect((await t.documents.get("D-a"))!.processing["image.ela"]).toBe("ERROR");
  });

  it("retries a transient failure and then succeeds", async () => {
    let calls = 0;
    const t = await setup({
      analyze: async (d) => {
        if (++calls < 3) throw new Error("connection refused");
        return okResponse(d);
      },
    });
    expect((await t.worker.processNext())!.status).toBe("QUEUED");
    expect((await t.worker.processNext())!.status).toBe("QUEUED");
    const last = (await t.worker.processNext())!;
    expect(last).toMatchObject({ status: "DONE", attempts: 3 });
  });

  it("fails for good after maxAttempts and does not store analysis", async () => {
    const t = await setup({ analyze: async () => { throw new Error("down"); } }, { maxAttempts: 2 });
    await t.worker.processNext();
    const last = (await t.worker.processNext())!;
    expect(last.status).toBe("FAILED");
    expect(last.error).toContain("down");
    expect(await t.analysis.get("D-a")).toBeUndefined();
    expect(await t.worker.processNext()).toBeUndefined();
  });

  it("does not retry a permanent error", async () => {
    const analyze = vi.fn(async () => { throw new PermanentAnalysisError("no fixture"); });
    const t = await setup({ analyze });
    const job = (await t.worker.processNext())!;
    expect(job).toMatchObject({ status: "FAILED", attempts: 1 });
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("times out a hung analysis, aborts it, and counts it as a failed attempt", async () => {
    let aborted = false;
    const t = await setup(
      { analyze: (_d, o) => new Promise((_, rej) => o?.signal?.addEventListener("abort", () => { aborted = true; rej(new Error("aborted")); })) },
      { timeoutMs: 30, maxAttempts: 1 },
    );
    const job = (await t.worker.processNext())!;
    expect(job.status).toBe("FAILED");
    expect(job.error).toMatch(/timed out after 30 ms/);
    expect(aborted).toBe(true);
  });

  it("rejects a response for the wrong document", async () => {
    const t = await setup({ analyze: async () => okResponse("D-other") });
    const job = (await t.worker.processNext())!;
    expect(job.status).toBe("FAILED");
    expect(job.error).toMatch(/D-other/);
    expect(await t.analysis.get("D-a")).toBeUndefined();
  });

  it("notifies listeners when a job finishes, but not on a retry", async () => {
    let calls = 0;
    const t = await setup({ analyze: async (d) => { if (++calls === 1) throw new Error("x"); return okResponse(d); } });
    const seen: Job[] = [];
    t.worker.onJobFinished((j) => { seen.push(j); });
    await t.worker.processNext(); // retry, no notification
    expect(seen).toHaveLength(0);
    await t.worker.processNext();
    expect(seen.map((j) => j.status)).toEqual(["DONE"]);
  });

  it("a failing listener does not break the worker", async () => {
    const t = await setup({ analyze: async (d) => okResponse(d) });
    t.worker.onJobFinished(() => { throw new Error("listener bug"); });
    expect((await t.worker.processNext())!.status).toBe("DONE");
  });
});

describe("Worker loop", () => {
  it("picks up queued work by itself and stops cleanly", async () => {
    const t = await setup({ analyze: async (d) => okResponse(d) });
    t.worker.start();
    await vi.waitFor(async () => expect((await t.jobs.get("JOB-0001"))!.status).toBe("DONE"), { timeout: 2000 });
    await t.worker.stop();
  });
});
