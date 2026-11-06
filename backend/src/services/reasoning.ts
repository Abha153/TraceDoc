import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ReasoningInput, ReasoningOutput } from "@contracts/reasoning";
import type { AnalyzeResponse, AnalyzerStatus, Job } from "@contracts/types";
import { AppError } from "../errors.js";
import type { Logger } from "../logger.js";
import type { EvidenceRepository, GenerationRecord } from "../repo/evidence.js";
import type { AnalysisRepository, DocumentRepository } from "../repo/repositories.js";
import { jobNumber } from "../repo/repositories.js";
import { runReasoning } from "../engine/index.js";
import type { JobService } from "./jobs.js";
import { remapIds } from "./remap.js";
import { Mutex } from "../util/mutex.js";

/** The reasoning engine's entry point (contracts/reasoning.ts), allowed to be async so a stub can read files. */
export type ReasoningFn = (input: ReasoningInput) => ReasoningOutput | Promise<ReasoningOutput>;

/** The real engine (Person 1, backend/src/engine). Pure and deterministic. */
export const engineReasoning: ReasoningFn = (input) => runReasoning(input);

/**
 * Stand-in that returns the recorded contracts/fixtures/<caseId>.reasoning.json, re-labelled with the real document ids.
 * It only knows the fixture cases and only works with the mock analysis client (documents are matched to fixtures by hash).
 */
export function createStubReasoning(opts: {
  fixturesDir: string;
  fixtureIdFor: (docId: string) => Promise<string | undefined>;
}): ReasoningFn {
  return async (input) => {
    let recorded: ReasoningOutput;
    try {
      recorded = JSON.parse(await readFile(path.join(opts.fixturesDir, `${input.caseId}.reasoning.json`), "utf8")) as ReasoningOutput;
    } catch {
      throw new AppError(409, "NO_STUB_REASONING", `The reasoning stub has no recorded output for ${input.caseId}`);
    }
    const mapping: Record<string, string> = {};
    for (const d of input.documents) {
      const fixtureId = await opts.fixtureIdFor(d.docId);
      if (fixtureId) mapping[fixtureId] = d.docId;
    }
    return remapIds(recorded, mapping);
  };
}

export interface PipelineDeps {
  documents: DocumentRepository;
  jobs: JobService;
  analysis: AnalysisRepository;
  evidence: EvidenceRepository;
  reason: ReasoningFn;
  logger: Logger;
  pipelineVersion: string;
}

interface CaseState {
  docCount: number;
  pending: boolean;
  inputs: AnalyzeResponse[];
  failedDocIds: string[];
}

/**
 * Runs the reasoning engine for a case and stores the result as a new evidence generation.
 *
 *  - It runs when every document of the case has finished (no job QUEUED or RUNNING), after each finished job,
 *    and on demand (recompute). It never re-analyses documents: it reads the stored analysis of each one.
 *  - A document whose analysis failed completely is still passed to the engine, as a document whose analyzers all
 *    reported ERROR. Coverage then drops, so a missing document can never read as "clean".
 *  - If the engine throws, nothing is stored and the earlier generation stays the current one.
 */
export class ReasoningPipeline {
  private readonly locks = new Map<string, Mutex>();

  constructor(private readonly d: PipelineDeps) {}

  private lock(caseId: string): Mutex {
    let m = this.locks.get(caseId);
    if (!m) this.locks.set(caseId, (m = new Mutex()));
    return m;
  }

  /** Hook for Worker.onJobFinished. */
  async onJobFinished(job: Job): Promise<void> {
    await this.lock(job.caseId).run(async () => {
      const state = await this.state(job.caseId);
      if (state.pending || state.inputs.length === 0) return;
      await this.execute(job.caseId, state);
    });
  }

  /** POST /cases/:id/recompute: same analyses, new generation. */
  recompute(caseId: string): Promise<GenerationRecord> {
    return this.lock(caseId).run(async () => {
      const state = await this.state(caseId);
      if (state.docCount === 0) throw new AppError(409, "NO_DOCUMENTS", "The case has no documents to reason over");
      if (state.pending) throw new AppError(409, "ANALYSIS_PENDING", "Analysis is still running for this case; try again when it has finished");
      return this.execute(caseId, state);
    });
  }

  private async state(caseId: string): Promise<CaseState> {
    const docs = await this.d.documents.listByCase(caseId);
    const jobs = await this.d.jobs.list();
    const done: AnalyzeResponse[] = [];
    const missing: string[] = [];
    let pending = false;
    for (const doc of docs) {
      const latest = jobs
        .filter((j) => j.docId === doc.docId)
        .sort((a, b) => jobNumber(a.jobId) - jobNumber(b.jobId))
        .at(-1);
      if (latest && (latest.status === "QUEUED" || latest.status === "RUNNING")) pending = true;
      const analysis = await this.d.analysis.get(doc.docId);
      // An analysis that reports no analyzers at all analysed nothing (only pages were rendered): treat it as failed, not as clean.
      if (analysis && Object.keys(analysis.analyzerStatuses).length > 0) done.push(analysis);
      else missing.push(doc.docId);
    }
    // analyzers that ran for the documents we do have; a failed document gets all of them as ERROR
    const ids = new Set<string>();
    for (const a of done) for (const [id, s] of Object.entries(a.analyzerStatuses)) if (s !== "NOT_APPLICABLE") ids.add(id);
    if (ids.size === 0) ids.add("ocr");
    const failed = new Set(missing);
    const byDoc = new Map(done.map((a) => [a.docId, a]));
    const inputs: AnalyzeResponse[] = [];
    for (const doc of docs) {
      const a = byDoc.get(doc.docId);
      if (a) inputs.push(a);
      else if (failed.has(doc.docId) && !pending) inputs.push(failedDocument(doc.docId, this.d.pipelineVersion, ids));
    }
    return { docCount: docs.length, pending, inputs, failedDocIds: missing };
  }

  private async execute(caseId: string, state: CaseState): Promise<GenerationRecord> {
    try {
      const output = await this.d.reason({ caseId, documents: state.inputs });
      const record = await this.d.evidence.put(caseId, output, state.inputs.flatMap((a) => a.signals));
      this.d.logger.info(
        { caseId, generation: record.generation, findings: record.findings.length, failedDocs: state.failedDocIds.length },
        "reasoning stored",
      );
      return record;
    } catch (err) {
      this.d.logger.error({ caseId, err }, "reasoning failed; the previous generation stays current");
      throw err;
    }
  }
}

function failedDocument(docId: string, pipelineVersion: string, analyzerIds: Set<string>): AnalyzeResponse {
  const statuses: Record<string, AnalyzerStatus> = {};
  for (const id of analyzerIds) statuses[id] = "ERROR";
  return { docId, pipelineVersion, pages: [], fields: [], signals: [], analyzerStatuses: statuses, provenance: [] };
}
