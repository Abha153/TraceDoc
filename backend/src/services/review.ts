import type { FindingDetail, ReviewRequest } from "@contracts/api";
import type { Job } from "@contracts/types";
import { AppError } from "../errors.js";
import type { EvidenceRepository } from "../repo/evidence.js";
import type { DocumentRepository } from "../repo/repositories.js";
import type { OverlayAnalysisRepository, OverridesRepository } from "../repo/overrides.js";
import type { DocType } from "@contracts/types";
import type { JsonlEventLog } from "./eventLog.js";
import { EventLogReviews } from "./eventLog.js";
import type { JobService } from "./jobs.js";
import { Mutex } from "../util/mutex.js";

/**
 * Analyst review of findings. A review appends an event; the finding itself (what the machine observed) is never
 * touched, and its review status is derived by replaying events.
 */
export class ReviewService {
  private readonly lock = new Mutex();
  private readonly reviews: EventLogReviews;

  constructor(
    private readonly evidence: EvidenceRepository,
    private readonly log: JsonlEventLog,
  ) {
    this.reviews = new EventLogReviews(log);
  }

  review(findingId: string, req: ReviewRequest, actor: string): Promise<FindingDetail> {
    return this.lock.run(async () => {
      const hit = await this.evidence.findFinding(findingId);
      if (!hit) throw new AppError(404, "FINDING_NOT_FOUND", "No such finding");
      if (!hit.isLatest) {
        throw new AppError(409, "STALE_GENERATION", "This finding belongs to an older reasoning run; review the current one instead");
      }
      const reason = req.reason?.trim() || undefined;
      const comment = req.comment?.trim() || undefined;
      const current = await this.reviews.statusOf(findingId);
      const base = { caseId: hit.finding.caseId, actor, targetId: findingId };

      switch (req.action) {
        case "CONFIRM":
          await this.log.append({ ...base, type: "REVIEW", payload: { status: "CONFIRMED", ...(reason ? { reason } : {}) } });
          break;
        case "INCONCLUSIVE":
          await this.log.append({ ...base, type: "REVIEW", payload: { status: "INCONCLUSIVE", ...(reason ? { reason } : {}) } });
          break;
        case "DISMISS":
          if (!reason) throw new AppError(400, "REASON_REQUIRED", "A reason is required to dismiss a finding");
          await this.log.append({ ...base, type: "REVIEW", payload: { status: "DISMISSED", reason } });
          break;
        case "COMMENT":
          if (!comment) throw new AppError(400, "COMMENT_REQUIRED", "A comment is required");
          await this.log.append({ ...base, type: "COMMENT", payload: { text: comment } });
          break;
        case "REOPEN":
          if (current === "UNREVIEWED") throw new AppError(409, "ALREADY_UNREVIEWED", "The finding has not been reviewed, so there is nothing to reopen");
          await this.log.append({ ...base, type: "REOPEN", payload: { previousStatus: current, ...(reason ? { reason } : {}) } });
          break;
      }
      return {
        finding: hit.finding,
        reviewStatus: await this.reviews.statusOf(findingId),
        reviewHistory: await this.reviews.historyOf(findingId),
      };
    });
  }
}

/** Analyst reclassification of a page: logged, stored as a correction, and a re-run is queued. */
export class ReclassifyService {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly analysis: OverlayAnalysisRepository,
    private readonly overrides: OverridesRepository,
    private readonly jobs: JobService,
    private readonly log: JsonlEventLog,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async reclassify(docId: string, page: number, docType: DocType, reason: string | undefined, actor: string): Promise<Job> {
    const doc = await this.documents.get(docId);
    if (!doc) throw new AppError(404, "DOCUMENT_NOT_FOUND", "No such document");
    const raw = await this.analysis.getRaw(docId);
    const machine = raw?.pages.find((p) => p.page === page);
    if (!machine) throw new AppError(404, "PAGE_NOT_FOUND", "No such page");

    const existing = await this.overrides.get(docId);
    const current = existing?.pages[String(page)]?.docType ?? machine.docType;
    if (docType === current) throw new AppError(400, "NO_CHANGE", `Page ${page} is already classified as ${current}`);

    const cleanReason = reason?.trim() || undefined;
    await this.overrides.put({
      docId,
      pages: {
        ...(existing?.pages ?? {}),
        [String(page)]: {
          docType,
          machineDocType: machine.docType,
          machineConfidence: machine.docTypeConfidence,
          by: actor,
          at: this.now().toISOString(),
          ...(cleanReason ? { reason: cleanReason } : {}),
        },
      },
    });
    await this.log.append({
      caseId: doc.caseId,
      actor,
      type: "RECLASSIFY",
      targetId: docId,
      payload: { page, from: current, to: docType, machineDocType: machine.docType, ...(cleanReason ? { reason: cleanReason } : {}) },
    });
    const { job, created } = await this.jobs.enqueue({ caseId: doc.caseId, docId, forced: true });
    if (created) {
      await this.log.append({ caseId: doc.caseId, actor, type: "RERUN", targetId: docId, payload: { jobId: job.jobId, cause: "reclassify" } });
    }
    return job;
  }
}
