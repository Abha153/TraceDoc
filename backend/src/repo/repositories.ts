import path from "node:path";
import type { AnalyzeResponse, DocumentRecord, Job } from "@contracts/types";
import type { Case } from "@contracts/api";
import { JsonDir } from "./jsonDir.js";

/** Repository interfaces keep the storage format swappable (JSON files now, a database later). */
export interface CaseRepository {
  put(c: Case): Promise<void>;
  get(caseId: string): Promise<Case | undefined>;
  list(): Promise<Case[]>;
}

export interface DocumentRepository {
  put(d: DocumentRecord): Promise<void>;
  get(docId: string): Promise<DocumentRecord | undefined>;
  listByCase(caseId: string): Promise<DocumentRecord[]>;
}

export interface JobRepository {
  put(j: Job): Promise<void>;
  get(jobId: string): Promise<Job | undefined>;
  list(): Promise<Job[]>;
}

/** The last AnalyzeResponse for a document. B8 reads pages, fields and signals from here. */
export interface AnalysisRepository {
  put(docId: string, r: AnalyzeResponse): Promise<void>;
  get(docId: string): Promise<AnalyzeResponse | undefined>;
}

export class JsonCaseRepository implements CaseRepository {
  private readonly store: JsonDir<Case>;
  constructor(recordsDir: string) {
    this.store = new JsonDir<Case>(path.join(recordsDir, "cases"));
  }
  put(c: Case) {
    return this.store.put(c.caseId, c);
  }
  get(caseId: string) {
    return this.store.get(caseId);
  }
  async list() {
    return (await this.store.list()).sort((a, b) => a.caseId.localeCompare(b.caseId));
  }
}

export class JsonDocumentRepository implements DocumentRepository {
  private readonly store: JsonDir<DocumentRecord>;
  constructor(recordsDir: string) {
    this.store = new JsonDir<DocumentRecord>(path.join(recordsDir, "documents"));
  }
  put(d: DocumentRecord) {
    return this.store.put(d.docId, d);
  }
  get(docId: string) {
    return this.store.get(docId);
  }
  async listByCase(caseId: string) {
    return (await this.store.list())
      .filter((d) => d.caseId === caseId)
      .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.docId.localeCompare(b.docId));
  }
}

export class JsonJobRepository implements JobRepository {
  private readonly store: JsonDir<Job>;
  constructor(recordsDir: string) {
    this.store = new JsonDir<Job>(path.join(recordsDir, "jobs"));
  }
  put(j: Job) {
    return this.store.put(j.jobId, j);
  }
  get(jobId: string) {
    return this.store.get(jobId);
  }
  async list() {
    return (await this.store.list()).sort((a, b) => jobNumber(a.jobId) - jobNumber(b.jobId));
  }
}

export class JsonAnalysisRepository implements AnalysisRepository {
  private readonly store: JsonDir<AnalyzeResponse>;
  constructor(recordsDir: string) {
    this.store = new JsonDir<AnalyzeResponse>(path.join(recordsDir, "analysis"));
  }
  put(docId: string, r: AnalyzeResponse) {
    return this.store.put(docId, r);
  }
  get(docId: string) {
    return this.store.get(docId);
  }
}

/** JOB-0007 -> 7. Job ids are sequential, which also gives a total order for FIFO and "latest". */
export function jobNumber(jobId: string): number {
  const m = /^JOB-(\d+)$/.exec(jobId);
  return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER;
}
