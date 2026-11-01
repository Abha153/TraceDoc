import type { DocumentRecord, Job } from "@contracts/types";
import type { UploadResponse } from "@contracts/api";
import type { DocumentRepository } from "../repo/repositories.js";
import type { IncomingFile, IngestService } from "./ingest.js";
import type { JobService } from "./jobs.js";

/** Store originals (B2), create a DocumentRecord for each, and queue one analysis job per document. */
export class UploadService {
  constructor(
    private readonly ingest: IngestService,
    private readonly documents: DocumentRepository,
    private readonly jobs: JobService,
    private readonly pipelineVersion: string,
  ) {}

  async upload(caseId: string, files: IncomingFile[]): Promise<UploadResponse> {
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
      jobs.push((await this.jobs.enqueue({ caseId, docId: s.docId })).job);
    }
    return { caseId, documents, jobs };
  }
}
