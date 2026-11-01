import type { DocumentRecord, Job } from "@contracts/types";
import type { Case, CaseSummary } from "@contracts/api";
import { AppError } from "../errors.js";
import type { CaseRepository, DocumentRepository } from "../repo/repositories.js";
import type { JobService } from "./jobs.js";
import { Mutex } from "../util/mutex.js";

export class CaseService {
  private readonly lock = new Mutex();

  constructor(
    private readonly cases: CaseRepository,
    private readonly documents: DocumentRepository,
    private readonly jobs: JobService,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Case ids are sequential: CASE-001, CASE-002, ... */
  create(title: string, createdBy: string): Promise<Case> {
    return this.lock.run(async () => {
      const used = (await this.cases.list()).map((c) => Number(/^CASE-(\d+)$/.exec(c.caseId)?.[1] ?? 0));
      const n = Math.max(0, ...used) + 1;
      const c: Case = {
        caseId: `CASE-${String(n).padStart(3, "0")}`,
        title,
        createdAt: this.now().toISOString(),
        createdBy,
      };
      await this.cases.put(c);
      return c;
    });
  }

  async require(caseId: string): Promise<Case> {
    const c = await this.cases.get(caseId);
    if (!c) throw new AppError(404, "CASE_NOT_FOUND", `No case ${caseId}`);
    return c;
  }

  async summary(c: Case): Promise<CaseSummary> {
    const documents: DocumentRecord[] = await this.documents.listByCase(c.caseId);
    const jobs: Job[] = (await this.jobs.list()).filter((j) => j.caseId === c.caseId);
    // priority stays null until reasoning has run for the case (B10)
    return { case: c, documents, jobs, priority: null, perDocumentPriority: {} };
  }

  async list(): Promise<CaseSummary[]> {
    return Promise.all((await this.cases.list()).map((c) => this.summary(c)));
  }
}
