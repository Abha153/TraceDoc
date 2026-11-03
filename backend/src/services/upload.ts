import type { DocumentRecord, Job } from "@contracts/types";
import type { UploadResponse } from "@contracts/api";
import type { DocumentRepository } from "../repo/repositories.js";
import type { IncomingFile, IngestService } from "./ingest.js";
import type { JobService } from "./jobs.js";
import type { JsonlEventLog } from "./eventLog.js";

/** Store originals (B2), create a DocumentRecord for each, and queue one analysis job per document. */
export class UploadService {
  constructor(
    private readonly ingest: IngestService,
    private readonly documents: DocumentRepository,
    private readonly jobs: JobService,
    private readonly pipelineVersion: string,
    private readonly log: JsonlEventLog,
  ) {}

  async upload(caseId: string, files: IncomingFile[], actor: string): Promise<UploadResponse> {
    const stored = await this.ingest.ingest(caseId, files);
    const documents: DocumentRecord[] = [];
    const jobs: Job[] = [];
    for (const s of stored) {
      // pageCount and processing are filled in when analysis finishes: nothing has run yet
      const record: DocumentRecord = {
        docId: s.docId,
        caseId,
        filename: s.filename,
        sha256: s.sha256,
        mimeType: s.mimeType,
        pageCount: 0,
        processing: {},
        pipelineVersion: this.pipelineVersion,
        receivedAt: s.receivedAt,
      };
      await this.documents.put(record);
      documents.push(record);
      const job = (await this.jobs.enqueue({ caseId, docId: s.docId })).job;
      jobs.push(job);
      await this.log.append({
        caseId, actor, type: "UPLOAD", targetId: s.docId, payload: { filename: s.filename, sha256: s.sha256, jobId: job.jobId },
      });
    }
    return { caseId, documents, jobs };
  }
}
