/**
 * REST API payloads (backend /api/v1, see openapi.yaml) and the internal Python service request/response.
 * Entity-level shapes (Finding, Job, ...) live in types.ts; this file only adds request/response wrappers.
 */
import type {
  AnalyzerStatus,
  DocType,
  DocumentAssertion,
  DocumentRecord,
  Entity,
  ExtractedField,
  Finding,
  InvestigationEvent,
  Job,
  PageRecord,
  PriorityResult,
  ReviewStatus,
} from "./types";

export interface ErrorResponse {
  error: { code: string; message: string };
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface Session {
  analystId: string;
  displayName: string;
}

export interface CreateCaseRequest {
  title: string;
}

export interface Case {
  caseId: string;
  title: string;
  createdAt: string;
  createdBy: string;
}

/** 202 response of POST /cases/:caseId/documents. */
export interface UploadResponse {
  caseId: string;
  documents: DocumentRecord[];
  jobs: Job[];
}

/** GET /cases/:caseId. priority is null until reasoning has run for the case. */
export interface CaseSummary {
  case: Case;
  documents: DocumentRecord[];
  jobs: Job[];
  priority: PriorityResult | null;
  perDocumentPriority: Record<string, PriorityResult>;
}

/** GET /documents/:docId. */
export interface DocumentDetail {
  document: DocumentRecord;
  pages: PageRecord[];
  fields: ExtractedField[];
}

export interface ReclassifyRequest {
  docType: DocType;
  reason?: string;
}

/** A finding plus the review state derived by replaying its events. The finding itself is never modified. */
export interface FindingWithReview {
  finding: Finding;
  reviewStatus: ReviewStatus;
}

export interface FindingDetail extends FindingWithReview {
  reviewHistory: InvestigationEvent[];
}

export interface ReviewRequest {
  action: "CONFIRM" | "DISMISS" | "INCONCLUSIVE" | "COMMENT" | "REOPEN";
  reason?: string; // required for DISMISS
  comment?: string; // required for COMMENT
}

export interface AssertionsResponse {
  caseId: string;
  assertions: DocumentAssertion[];
}

export interface EntitiesResponse {
  caseId: string;
  entities: Entity[];
}

export interface FindingsResponse {
  caseId: string;
  findings: FindingWithReview[];
}

export interface EventsResponse {
  caseId: string;
  events: InvestigationEvent[];
}

export interface GraphNode {
  id: string; // docId or entityId
  kind: "document" | "entity";
  label: string;
  docType?: DocType;
  role?: Entity["role"];
  resolution?: Entity["resolution"];
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "contains" | "match" | "conflict" | "suggested";
  findingId?: string;
  label?: string;
}

export interface GraphResponse {
  caseId: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface IntegrityDocumentResult {
  docId: string;
  expectedSha256: string;
  actualSha256: string | null; // null if the file is missing
  status: "PASS" | "FAIL";
}

export interface IntegrityReport {
  caseId: string;
  checkedAt: string;
  status: "PASS" | "FAIL";
  documents: IntegrityDocumentResult[];
}

/** GET /cases/:caseId/dossier?format=json. The PDF carries the same content. */
export interface DossierJson {
  caseId: string;
  generatedAt: string;
  summary: CaseSummary;
  assertions: DocumentAssertion[];
  entities: Entity[];
  findings: FindingWithReview[];
  reviewHistory: InvestigationEvent[];
  analyzerStatuses: Record<string, Record<string, AnalyzerStatus>>; // docId -> analyzer -> status
  limitations: string[]; // gaps: UNAVAILABLE/ERROR analyzers, unsupported formats, ...
  integrity: IntegrityReport;
}

/** GET /compliance/retention-policy. Reports configuration only; nothing is purged automatically. */
export interface RetentionPolicy {
  rawEvidenceRetentionDays: number;
  /** Always false in this prototype: the policy is served, but no purge job exists. */
  purgeImplemented: false;
  note: string;
}

/** Shape of contracts/fixtures/CASE-00x.case.json: everything the frontend mock server needs besides reasoning output. */
export interface CaseFixture {
  case: Case;
  documents: DocumentRecord[];
  jobs: Job[];
  investigationEvents: InvestigationEvent[];
}

/** Python service, POST /analyze. Takes a document ID, never a filesystem path. */
export interface AnalyzeRequest {
  docId: string;
  pipelineVersion?: string;
  analyzers?: string[]; // restrict to these analyzer ids (default: all registered)
}

/** Python service, GET /health. */
export interface HealthResponse {
  status: "ok" | "degraded";
  version: string;
  analyzers: Record<string, AnalyzerStatus>;
}
