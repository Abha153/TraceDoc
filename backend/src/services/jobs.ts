import type { AnalyzeResponse, AnalyzerProgress, AnalyzerRunState, AnalyzerStatus, Job, JobStatus } from "@contracts/types";
import { AppError } from "../errors.js";
import { jobNumber, type JobRepository } from "../repo/repositories.js";
import { Mutex } from "../util/mutex.js";

export interface JobServiceOptions {
  pipelineVersion: string;
  maxAttempts: number;
  now?: () => Date;
}

const RUN_STATE: Record<AnalyzerStatus, AnalyzerRunState> = {
  AVAILABLE: "DONE",
  ERROR: "ERROR",
  UNAVAILABLE: "UNAVAILABLE",
  NOT_APPLICABLE: "NOT_APPLICABLE",
};

/**
 * Job lifecycle on top of a JobRepository. Every mutation runs under one lock, so enqueue,
 * claim and finish never interleave inside this process.
 *
 * Rules:
 *  - idempotency: one job per (docId, pipelineVersion). Enqueueing again returns the existing job,
 *    unless `forced` and that job has finished. A forced job is a new job with `forced: true`.
 *  - retries: `attempts` counts runs started. A failed run goes back to QUEUED until attempts reaches
 *    maxAttempts, then the job is FAILED.
 *  - results: some analyzers ERROR/UNAVAILABLE and some AVAILABLE gives PARTIAL. None AVAILABLE gives FAILED.
 *    A missing analyzer is never reported as clean.
 */
export class JobService {
  private readonly lock = new Mutex();
  private readonly now: () => Date;

  constructor(
    private readonly repo: JobRepository,
    private readonly opts: JobServiceOptions,
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  private stamp(): string {
    return this.now().toISOString();
  }

  get(jobId: string): Promise<Job | undefined> {
    return this.repo.get(jobId);
  }

  list(): Promise<Job[]> {
    return this.repo.list();
  }

  enqueue(input: { caseId: string; docId: string; forced?: boolean }): Promise<{ job: Job; created: boolean }> {
    return this.lock.run(async () => {
      const all = await this.repo.list();
      const { pipelineVersion, maxAttempts } = this.opts;
      const same = all.filter((j) => j.docId === input.docId && j.pipelineVersion === pipelineVersion);
      const latest = same[same.length - 1]; // list() is ordered by job number
      if (latest && (!input.forced || latest.status === "QUEUED" || latest.status === "RUNNING")) {
        return { job: latest, created: false };
      }
      const next = all.reduce((m, j) => Math.max(m, jobNumber(j.jobId) === Number.MAX_SAFE_INTEGER ? 0 : jobNumber(j.jobId)), 0) + 1;
      const at = this.stamp();
      const job: Job = {
        jobId: `JOB-${String(next).padStart(4, "0")}`,
        caseId: input.caseId,
        docId: input.docId,
        pipelineVersion,
        status: "QUEUED",
        analyzers: {},
        attempts: 0,
        maxAttempts,
        ...(input.forced ? { forced: true } : {}),
        createdAt: at,
        updatedAt: at,
      };
      await this.repo.put(job);
      return { job, created: true };
    });
  }

  /** Oldest QUEUED job becomes RUNNING and its attempt counter goes up. */
  claimNext(): Promise<Job | undefined> {
    return this.lock.run(async () => {
      const next = (await this.repo.list()).find((j) => j.status === "QUEUED");
      if (!next) return undefined;
      const running: Job = { ...next, status: "RUNNING", attempts: next.attempts + 1, updatedAt: this.stamp() };
      await this.repo.put(running);
      return running;
    });
  }

  complete(jobId: string, resp: AnalyzeResponse): Promise<Job> {
    return this.lock.run(async () => {
      const job = await this.mustGet(jobId);
      const at = this.stamp();
      const entries = Object.entries(resp.analyzerStatuses);
      const available = entries.filter(([, s]) => s === "AVAILABLE").length;
      const broken = entries.filter(([, s]) => s === "ERROR" || s === "UNAVAILABLE").length;
      const status: JobStatus = broken === 0 ? "DONE" : available > 0 ? "PARTIAL" : "FAILED";

      const analyzers: Record<string, AnalyzerProgress> = {};
      for (const [id, s] of entries) {
        const p: AnalyzerProgress = { state: RUN_STATE[s], analyzerStatus: s };
        if (s !== "NOT_APPLICABLE") {
          p.startedAt = job.updatedAt;
          p.finishedAt = at;
        }
        if (s === "ERROR" || s === "UNAVAILABLE") {
          const note = resp.provenance.find((pr) => pr.analyzer === id)?.config?.error;
          p.message = typeof note === "string" ? note : `analyzer reported ${s}`;
        }
        analyzers[id] = p;
      }
      const { error: _drop, ...rest } = job;
      const done: Job = { ...rest, status, analyzers, updatedAt: at };
      if (status === "FAILED") done.error = "no analyzer produced a usable result";
      await this.repo.put(done);
      return done;
    });
  }

  /** A run failed. Re-queue it, or fail it for good when attempts are used up or the error is permanent. */
  failAttempt(jobId: string, message: string, opts: { retry?: boolean } = {}): Promise<Job> {
    return this.lock.run(async () => {
      const job = await this.mustGet(jobId);
      const retry = (opts.retry ?? true) && job.attempts < job.maxAttempts;
      const next: Job = {
        ...job,
        status: retry ? "QUEUED" : "FAILED",
        error: retry ? message : `${message} (attempt ${job.attempts} of ${job.maxAttempts})`,
        updatedAt: this.stamp(),
      };
      await this.repo.put(next);
      return next;
    });
  }

  /**
   * Call once at startup. A job still marked RUNNING belongs to a process that died, so it goes back to
   * QUEUED, or to FAILED if it has already used all its attempts. Returns the number of jobs touched.
   */
  recoverRunning(): Promise<number> {
    return this.lock.run(async () => {
      let n = 0;
      for (const job of await this.repo.list()) {
        if (job.status !== "RUNNING") continue;
        const exhausted = job.attempts >= job.maxAttempts;
        const analyzers = Object.fromEntries(
          Object.entries(job.analyzers).map(([k, v]) => [k, v.state === "RUNNING" ? { ...v, state: "PENDING" as const } : v]),
        );
        await this.repo.put({
          ...job,
          analyzers,
          status: exhausted ? "FAILED" : "QUEUED",
          error: exhausted ? "interrupted by a restart after the last attempt" : "interrupted by a restart",
          updatedAt: this.stamp(),
        });
        n++;
      }
      return n;
    });
  }

  private async mustGet(jobId: string): Promise<Job> {
    const job = await this.repo.get(jobId);
    if (!job) throw new AppError(404, "JOB_NOT_FOUND", `No job ${jobId}`);
    return job;
  }
}
