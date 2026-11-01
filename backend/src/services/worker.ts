import type { Job } from "@contracts/types";
import type { Logger } from "../logger.js";
import type { AnalysisRepository, DocumentRepository } from "../repo/repositories.js";
import { AnalysisTimeoutError, PermanentAnalysisError, type AnalysisClient } from "./analysisClient.js";
import type { JobService } from "./jobs.js";

export interface WorkerDeps {
  jobs: JobService;
  client: AnalysisClient;
  analysis: AnalysisRepository;
  documents: DocumentRepository;
  logger: Logger;
  timeoutMs: number;
  pollMs: number;
  retryDelayMs: number;
}

type FinishedListener = (job: Job) => void | Promise<void>;

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ctrl = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // reject first: aborting makes the client throw its own "aborted" error, which must not win the race
      reject(new AnalysisTimeoutError(`analysis timed out after ${ms} ms`));
      ctrl.abort();
    }, ms);
  });
  try {
    return await Promise.race([fn(ctrl.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Processes queued jobs one at a time. `processNext` is public so tests can drive it without timers. */
export class Worker {
  private readonly listeners: FinishedListener[] = [];
  private stopped = true;
  private loop?: Promise<void>;
  private wake?: () => void;

  constructor(private readonly d: WorkerDeps) {}

  /** Called when a job reaches DONE, PARTIAL or FAILED (not when it is re-queued for a retry). */
  onJobFinished(cb: FinishedListener): void {
    this.listeners.push(cb);
  }

  async processNext(): Promise<Job | undefined> {
    const claimed = await this.d.jobs.claimNext();
    if (!claimed) return undefined;
    let final: Job;
    try {
      const resp = await withTimeout((signal) => this.d.client.analyze(claimed.docId, { signal }), this.d.timeoutMs);
      if (resp.docId !== claimed.docId) {
        throw new PermanentAnalysisError(`analysis returned docId ${resp.docId} for ${claimed.docId}`);
      }
      await this.d.analysis.put(claimed.docId, resp);
      const doc = await this.d.documents.get(claimed.docId);
      if (doc) {
        await this.d.documents.put({
          ...doc,
          pageCount: resp.pages.length,
          processing: resp.analyzerStatuses,
          pipelineVersion: resp.pipelineVersion,
        });
      }
      final = await this.d.jobs.complete(claimed.jobId, resp);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.d.logger.warn({ jobId: claimed.jobId, attempt: claimed.attempts, err: message }, "analysis attempt failed");
      final = await this.d.jobs.failAttempt(claimed.jobId, message, { retry: !(err instanceof PermanentAnalysisError) });
    }
    if (final.status !== "QUEUED") {
      for (const cb of this.listeners) {
        try {
          await cb(final);
        } catch (err) {
          this.d.logger.error({ jobId: final.jobId, err }, "job-finished listener failed");
        }
      }
    }
    return final;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.loop;
  }

  private sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      let job: Job | undefined;
      try {
        job = await this.processNext();
      } catch (err) {
        this.d.logger.error({ err }, "worker error");
      }
      if (!job) await this.sleep(this.d.pollMs);
      else if (job.status === "QUEUED") await this.sleep(this.d.retryDelayMs);
    }
  }
}
