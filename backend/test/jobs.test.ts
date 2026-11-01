import { describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AnalyzeResponse, AnalyzerStatus } from "@contracts/types";
import { JsonJobRepository } from "../src/repo/repositories.js";
import { JobService } from "../src/services/jobs.js";

async function setup(over: { maxAttempts?: number; pipelineVersion?: string } = {}, dir?: string) {
  const d = dir ?? (await mkdtemp(path.join(tmpdir(), "td-jobs-")));
  const svc = new JobService(new JsonJobRepository(d), {
    pipelineVersion: over.pipelineVersion ?? "0.1.0",
    maxAttempts: over.maxAttempts ?? 3,
    now: () => new Date("2026-11-01T09:00:00Z"),
  });
  return { d, svc };
}

const resp = (docId: string, statuses: Record<string, AnalyzerStatus>, errors: Record<string, string> = {}): AnalyzeResponse => ({
  docId,
  pipelineVersion: "0.1.0",
  pages: [],
  fields: [],
  signals: [],
  analyzerStatuses: statuses,
  provenance: Object.entries(errors).map(([analyzer, error]) => ({
    analyzer,
    analyzerVersion: "0.1",
    config: { error },
    inputSha256: "0".repeat(64),
    processedAt: "2026-11-01T09:00:00Z",
    status: "ERROR" as const,
  })),
});

describe("enqueue and idempotency", () => {
  it("creates sequential job ids in QUEUED state with attempts 0", async () => {
    const { svc } = await setup();
    const a = await svc.enqueue({ caseId: "CASE-001", docId: "D-a" });
    const b = await svc.enqueue({ caseId: "CASE-001", docId: "D-b" });
    expect(a.job).toMatchObject({ jobId: "JOB-0001", status: "QUEUED", attempts: 0, maxAttempts: 3, analyzers: {} });
    expect(b.job.jobId).toBe("JOB-0002");
    expect(a.created && b.created).toBe(true);
  });

  it("returns the existing job for the same (docId, pipelineVersion)", async () => {
    const { svc } = await setup();
    const a = await svc.enqueue({ caseId: "C", docId: "D-a" });
    const again = await svc.enqueue({ caseId: "C", docId: "D-a" });
    expect(again.created).toBe(false);
    expect(again.job.jobId).toBe(a.job.jobId);
    expect((await svc.list()).length).toBe(1);
  });

  it("is idempotent even after the job finished", async () => {
    const { svc } = await setup();
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    const run = (await svc.claimNext())!;
    await svc.complete(run.jobId, resp("D-a", { ocr: "AVAILABLE" }));
    const again = await svc.enqueue({ caseId: "C", docId: "D-a" });
    expect(again.created).toBe(false);
    expect(again.job.status).toBe("DONE");
  });

  it("a new pipelineVersion is a new job", async () => {
    const { d, svc } = await setup();
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    const { svc: v2 } = await setup({ pipelineVersion: "0.2.0" }, d);
    const j = await v2.enqueue({ caseId: "C", docId: "D-a" });
    expect(j.created).toBe(true);
    expect(j.job.pipelineVersion).toBe("0.2.0");
  });

  it("forced re-run creates a new job once the old one has finished, and is marked forced", async () => {
    const { svc } = await setup();
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    const run = (await svc.claimNext())!;
    await svc.complete(run.jobId, resp("D-a", { ocr: "AVAILABLE" }));
    const forced = await svc.enqueue({ caseId: "C", docId: "D-a", forced: true });
    expect(forced.created).toBe(true);
    expect(forced.job).toMatchObject({ jobId: "JOB-0002", forced: true, status: "QUEUED" });
    // and a second forced request while that one is still queued does not pile up
    expect((await svc.enqueue({ caseId: "C", docId: "D-a", forced: true })).created).toBe(false);
  });
});

describe("claiming", () => {
  it("is FIFO and moves the job to RUNNING with attempts + 1", async () => {
    const { svc } = await setup();
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    await svc.enqueue({ caseId: "C", docId: "D-b" });
    const first = (await svc.claimNext())!;
    expect(first).toMatchObject({ docId: "D-a", status: "RUNNING", attempts: 1 });
    expect((await svc.claimNext())!.docId).toBe("D-b");
    expect(await svc.claimNext()).toBeUndefined();
  });
});

describe("results", () => {
  it("DONE when every analyzer is AVAILABLE or NOT_APPLICABLE", async () => {
    const { svc } = await setup();
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    const run = (await svc.claimNext())!;
    const done = await svc.complete(run.jobId, resp("D-a", { ocr: "AVAILABLE", "pdf.fonts": "NOT_APPLICABLE" }));
    expect(done.status).toBe("DONE");
    expect(done.analyzers["ocr"]).toMatchObject({ state: "DONE", analyzerStatus: "AVAILABLE" });
    expect(done.analyzers["pdf.fonts"]).toEqual({ state: "NOT_APPLICABLE", analyzerStatus: "NOT_APPLICABLE" });
    expect(done.error).toBeUndefined();
  });

  it("PARTIAL when some analyzers failed, and the failure is visible per analyzer", async () => {
    const { svc } = await setup();
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    const run = (await svc.claimNext())!;
    const done = await svc.complete(
      run.jobId,
      resp("D-a", { ocr: "AVAILABLE", "image.copymove": "ERROR", signature: "UNAVAILABLE" }, { "image.copymove": "timed out" }),
    );
    expect(done.status).toBe("PARTIAL");
    expect(done.analyzers["image.copymove"]).toMatchObject({ state: "ERROR", analyzerStatus: "ERROR", message: "timed out" });
    expect(done.analyzers["signature"]).toMatchObject({ state: "UNAVAILABLE", analyzerStatus: "UNAVAILABLE" });
  });

  it("FAILED when no analyzer produced anything", async () => {
    const { svc } = await setup();
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    const run = (await svc.claimNext())!;
    const done = await svc.complete(run.jobId, resp("D-a", { ocr: "ERROR", "image.ela": "UNAVAILABLE" }));
    expect(done.status).toBe("FAILED");
    expect(done.error).toBeTruthy();
  });

  it("clears an earlier attempt's error once a later attempt succeeds", async () => {
    const { svc } = await setup();
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    const r1 = (await svc.claimNext())!;
    await svc.failAttempt(r1.jobId, "network down");
    const r2 = (await svc.claimNext())!;
    expect(r2.attempts).toBe(2);
    const done = await svc.complete(r2.jobId, resp("D-a", { ocr: "AVAILABLE" }));
    expect(done.status).toBe("DONE");
    expect("error" in done).toBe(false);
  });
});

describe("retry limits", () => {
  it("re-queues until maxAttempts is used up, then FAILED with the last error", async () => {
    const { svc } = await setup({ maxAttempts: 3 });
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    const seen: string[] = [];
    for (let i = 0; i < 3; i++) {
      const run = (await svc.claimNext())!;
      expect(run.attempts).toBe(i + 1);
      seen.push((await svc.failAttempt(run.jobId, "boom")).status);
    }
    expect(seen).toEqual(["QUEUED", "QUEUED", "FAILED"]);
    expect(await svc.claimNext()).toBeUndefined();
    const job = (await svc.get("JOB-0001"))!;
    expect(job.status).toBe("FAILED");
    expect(job.error).toContain("boom");
    expect(job.attempts).toBe(3);
  });

  it("a permanent error fails immediately without using the other attempts", async () => {
    const { svc } = await setup({ maxAttempts: 3 });
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    const run = (await svc.claimNext())!;
    const failed = await svc.failAttempt(run.jobId, "no fixture", { retry: false });
    expect(failed.status).toBe("FAILED");
    expect(failed.attempts).toBe(1);
  });
});

describe("restart recovery", () => {
  it("moves RUNNING jobs back to QUEUED (new service instance over the same files) and keeps attempts", async () => {
    const { d, svc } = await setup();
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    await svc.enqueue({ caseId: "C", docId: "D-b" });
    await svc.claimNext(); // D-a is RUNNING when the "process dies"

    const { svc: restarted } = await setup({}, d);
    expect(await restarted.recoverRunning()).toBe(1);
    const a = (await restarted.get("JOB-0001"))!;
    expect(a).toMatchObject({ status: "QUEUED", attempts: 1 });
    expect(a.error).toMatch(/restart/);
    expect((await restarted.get("JOB-0002"))!.status).toBe("QUEUED");
    // and the recovered job is picked up again, as attempt 2
    expect(await restarted.claimNext()).toMatchObject({ jobId: "JOB-0001", attempts: 2 });
  });

  it("fails a recovered job that had already used its last attempt", async () => {
    const { d, svc } = await setup({ maxAttempts: 1 });
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    await svc.claimNext();
    const { svc: restarted } = await setup({ maxAttempts: 1 }, d);
    await restarted.recoverRunning();
    expect((await restarted.get("JOB-0001"))!.status).toBe("FAILED");
  });

  it("does nothing when no job is RUNNING and leaves finished jobs alone", async () => {
    const { svc } = await setup();
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    const run = (await svc.claimNext())!;
    await svc.complete(run.jobId, resp("D-a", { ocr: "AVAILABLE" }));
    expect(await svc.recoverRunning()).toBe(0);
    expect((await svc.get(run.jobId))!.status).toBe("DONE");
  });

  it("resets analyzer progress that was mid-run", async () => {
    const { d, svc } = await setup();
    await svc.enqueue({ caseId: "C", docId: "D-a" });
    const run = (await svc.claimNext())!;
    // simulate progress written while running
    const repo = new JsonJobRepository(d);
    await repo.put({ ...run, analyzers: { ocr: { state: "RUNNING" }, "image.ela": { state: "DONE", analyzerStatus: "AVAILABLE" } } });
    await svc.recoverRunning();
    const job = (await svc.get(run.jobId))!;
    expect(job.analyzers["ocr"]!.state).toBe("PENDING");
    expect(job.analyzers["image.ela"]!.state).toBe("DONE");
  });
});
