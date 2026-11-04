import { http, HttpResponse } from "msw";
import type {
  Case,
  CaseSummary,
  CreateCaseRequest,
  DossierJson,
  FindingDetail,
  FindingWithReview,
  ReviewRequest,
  UploadResponse,
} from "../../../contracts/api";
import type {
  AnalyzerStatus,
  DocumentRecord,
  Finding,
  InvestigationEvent,
  Job,
  ReviewStatus,
} from "../../../contracts/types";
import type { ReasoningOutput } from "../../../contracts/reasoning";
import {
  caseById,
  caseList,
  documentsByCase,
  emptyIntegrity,
  eventsForCase,
  fixtureAnalysis,
  fixtureCases,
  fixtureGraphs,
  fixtureReasoning,
} from "../mockData";

const API = "*/api/v1";
const additionalCases = new Map<string, Case>();
const additionalDocuments = new Map<string, DocumentRecord[]>();
const additionalJobs = new Map<string, Job>();
const pollingCounts = new Map<string, number>();
const reviewStatus = new Map<string, ReviewStatus>();
const reviewEvents: InvestigationEvent[] = [];

/** Same payload shapes the real backend writes (B9): REVIEW {status, reason?}, COMMENT {text}, REOPEN {previousStatus, reason?}. */
function reviewPayload(body: ReviewRequest, status: string, previousStatus: string): Record<string, unknown> {
  const reason = body.reason?.trim();
  if (body.action === "COMMENT") return { text: body.comment?.trim() ?? "" };
  if (body.action === "REOPEN") return { previousStatus, ...(reason ? { reason } : {}) };
  return { status, ...(reason ? { reason } : {}) };
}

function allCases() {
  return [...caseList(), ...additionalCases.values()];
}

function getCase(caseId: string) {
  return caseById.get(caseId) ?? additionalCases.get(caseId);
}

function caseDocuments(caseId: string) {
  return [
    ...(documentsByCase.get(caseId)?.documents ?? []),
    ...(additionalDocuments.get(caseId) ?? []),
  ];
}

function caseJobs(caseId: string) {
  return [
    ...(documentsByCase.get(caseId)?.jobs ?? []),
    ...[...additionalJobs.values()].filter((job) => job.caseId === caseId),
  ];
}

function reasoning(caseId: string): ReasoningOutput | undefined {
  return fixtureReasoning[caseId];
}

function currentFindings(caseId: string): FindingWithReview[] {
  return (reasoning(caseId)?.findings ?? []).map((finding) => ({
    finding,
    reviewStatus: reviewStatus.get(finding.findingId) ?? "UNREVIEWED",
  }));
}

function currentEvents(caseId: string): InvestigationEvent[] {
  return [
    ...eventsForCase(caseId),
    ...reviewEvents.filter((event) => event.caseId === caseId),
  ];
}

function caseSummary(caseId: string): CaseSummary | null {
  const item = getCase(caseId);
  if (!item) return null;
  const caseReasoning = reasoning(caseId);
  return {
    case: item,
    documents: caseDocuments(caseId),
    jobs: caseJobs(caseId),
    priority: caseReasoning?.priority.perCase ?? null,
    perDocumentPriority: caseReasoning?.priority.perDocument ?? {},
  };
}

function progression(job: Job): Job {
  const count = (pollingCounts.get(job.jobId) ?? 0) + 1;
  pollingCounts.set(job.jobId, count);
  if (count === 1) return job;

  const filename = caseDocuments(job.caseId).find((document) => document.docId === job.docId)?.filename ?? "";
  const failureFixture = /fail/i.test(filename);
  const status: Job["status"] = count === 2
    ? "RUNNING"
    : failureFixture
      ? "FAILED"
      : job.attempts > 1
        ? "DONE"
        : "PARTIAL";
  const now = new Date().toISOString();
  const message = status === "RUNNING"
    ? "Fixture lifecycle is running; no analysis is performed."
    : status === "FAILED"
      ? "Fixture failure simulation; no analysis output was generated."
      : "Fixture mode: no document analysis is performed.";
  const analyzerStatus: AnalyzerStatus = status === "FAILED" ? "ERROR" : "UNAVAILABLE";
  const analyzers: Job["analyzers"] = Object.fromEntries(
    Object.keys(job.analyzers).map((name) => [
      name,
      {
        state: status === "RUNNING" ? "RUNNING" : status === "FAILED" ? "ERROR" : "UNAVAILABLE",
        analyzerStatus,
        message,
      },
    ]),
  );
  const updated: Job = {
    ...job,
    status,
    analyzers,
    updatedAt: now,
    ...(status === "FAILED" ? { error: "Fixture failure simulation for a file named with 'fail'." } : {}),
  };
  additionalJobs.set(job.jobId, updated);
  return updated;
}

export function registerFixtureUpload(response: UploadResponse) {
  additionalDocuments.set(response.caseId, [
    ...(additionalDocuments.get(response.caseId) ?? []),
    ...response.documents,
  ]);
  response.jobs.forEach((job) => additionalJobs.set(job.jobId, job));
}

export function retryFixtureJob(jobId: string): Job {
  const job = additionalJobs.get(jobId);
  if (!job) throw new Error("Retry is available only for fixture-mode uploads.");
  if (job.attempts >= job.maxAttempts) throw new Error("The job has reached its maximum retry attempts.");

  const retry: Job = {
    ...job,
    status: "QUEUED",
    attempts: job.attempts + 1,
    updatedAt: new Date().toISOString(),
    error: undefined,
    analyzers: Object.fromEntries(
      Object.keys(job.analyzers).map((name) => [name, { state: "PENDING" as const }]),
    ),
  };
  pollingCounts.set(job.jobId, 0);
  additionalJobs.set(job.jobId, retry);
  return retry;
}

function dossier(caseId: string): DossierJson | null {
  const summary = caseSummary(caseId);
  const caseReasoning = reasoning(caseId);
  if (!summary || !caseReasoning) return null;
  return {
    caseId,
    generatedAt: new Date().toISOString(),
    summary,
    assertions: caseReasoning.assertions,
    entities: caseReasoning.entities,
    findings: currentFindings(caseId),
    reviewHistory: currentEvents(caseId).filter((event) => event.type === "REVIEW" || event.type === "COMMENT"),
    analyzerStatuses: Object.fromEntries(
      summary.documents.map((document) => [document.docId, document.processing]),
    ),
    limitations: [
      "Fixture mode: no uploaded document is analyzed.",
      "Recorded fixture analyzer outputs are synthetic and are not live processing.",
    ],
    integrity: emptyIntegrity(caseId),
  };
}

export const handlers = [
  http.post(`${API}/auth/login`, async ({ request }) => {
    const body = await request.json() as { username?: string; password?: string };
    if (!body.username || !body.password) {
      return HttpResponse.json(
        { error: { code: "INVALID_CREDENTIALS", message: "Enter a username and password." } },
        { status: 400 },
      );
    }
    return HttpResponse.json({
      analystId: body.username,
      displayName: body.username.split("@")[0] || "Analyst",
    });
  }),

  http.post(`${API}/auth/logout`, () => new HttpResponse(null, { status: 204 })),
  http.get(`${API}/auth/me`, () =>
    HttpResponse.json({ analystId: "analyst@tracedocs.local", displayName: "Sample Analyst" }),
  ),
  http.get(`${API}/cases`, () =>
    HttpResponse.json(allCases().map((item) => caseSummary(item.caseId)).filter((summary): summary is CaseSummary => summary !== null)),
  ),
  http.post(`${API}/cases`, async ({ request }) => {
    const { title } = await request.json() as CreateCaseRequest;
    const now = new Date().toISOString();
    const item = {
      caseId: `CASE-DEMO-${Date.now().toString(36).toUpperCase()}`,
      title: title.trim(),
      createdAt: now,
      createdBy: "fixture-analyst",
    };
    additionalCases.set(item.caseId, item);
    additionalDocuments.set(item.caseId, []);
    return HttpResponse.json(item, { status: 201 });
  }),
  http.get(`${API}/cases/:caseId`, ({ params }) => {
    const summary = caseSummary(String(params.caseId));
    return summary
      ? HttpResponse.json(summary)
      : HttpResponse.json({ error: { code: "CASE_NOT_FOUND", message: "Case not found." } }, { status: 404 });
  }),
  http.post(`${API}/cases/:caseId/documents`, async ({ params, request }) => {
    const caseId = String(params.caseId);
    if (!getCase(caseId)) {
      return HttpResponse.json({ error: { code: "CASE_NOT_FOUND", message: "Case not found." } }, { status: 404 });
    }
    const formData = await request.formData();
    const files = formData.getAll("files").filter((value): value is File => value instanceof File);
    const now = new Date().toISOString();
    const documents: DocumentRecord[] = files.map((file, index) => {
      const docId = `DEMO-${Date.now().toString(36).toUpperCase()}-${index + 1}`;
      const processing = Object.fromEntries(
        ["ocr", "pdf.textlayer", "pdf.fonts", "image.ela", "image.noise", "image.copymove", "signature"]
          .map((analyzer) => [analyzer, "UNAVAILABLE" as const]),
      );
      return {
        docId,
        caseId,
        filename: file.name,
        sha256: "0".repeat(64),
        mimeType: file.type || "application/octet-stream",
        pageCount: 1,
        processing,
        pipelineVersion: "fixture-only",
        receivedAt: now,
      };
    });
    const jobs: Job[] = documents.map((document, index) => {
      const job: Job = {
        jobId: `DEMO-JOB-${Date.now().toString(36).toUpperCase()}-${index + 1}`,
        caseId,
        docId: document.docId,
        pipelineVersion: "fixture-only",
        status: "QUEUED",
        analyzers: Object.fromEntries(
          Object.keys(document.processing).map((analyzer) => [analyzer, { state: "PENDING" }]),
        ),
        attempts: 1,
        maxAttempts: 3,
        createdAt: now,
        updatedAt: now,
      };
      return job;
    });
    const response: UploadResponse = { caseId, documents, jobs };
    registerFixtureUpload(response);
    return HttpResponse.json(response, { status: 202 });
  }),
  http.get(`${API}/jobs/:jobId`, ({ params }) => {
    const jobId = String(params.jobId);
    const job = additionalJobs.get(jobId) ??
      fixtureCases.flatMap((item) => item.jobs).find((candidate) => candidate.jobId === jobId);
    return job
      ? HttpResponse.json(additionalJobs.has(jobId) ? progression(job) : job)
      : HttpResponse.json({ error: { code: "JOB_NOT_FOUND", message: "Job not found." } }, { status: 404 });
  }),
  http.get(`${API}/documents/:docId`, ({ params }) => {
    const docId = String(params.docId);
    const document = fixtureCases.flatMap((item) => item.documents).find((item) => item.docId === docId)
      ?? [...additionalDocuments.values()].flat().find((item) => item.docId === docId);
    if (!document) {
      return HttpResponse.json({ error: { code: "DOCUMENT_NOT_FOUND", message: "Document not found." } }, { status: 404 });
    }
    const analysis = fixtureAnalysis[docId];
    return HttpResponse.json({
      document,
      pages: analysis?.pages ?? [],
      fields: analysis?.fields ?? [],
    });
  }),
  http.get(`${API}/cases/:caseId/assertions`, ({ params }) => {
    const caseId = String(params.caseId);
    return HttpResponse.json({ caseId, assertions: reasoning(caseId)?.assertions ?? [] });
  }),
  http.get(`${API}/cases/:caseId/entities`, ({ params }) => {
    const caseId = String(params.caseId);
    return HttpResponse.json({ caseId, entities: reasoning(caseId)?.entities ?? [] });
  }),
  http.get(`${API}/cases/:caseId/findings`, ({ params }) => {
    const caseId = String(params.caseId);
    return HttpResponse.json({ caseId, findings: currentFindings(caseId) });
  }),
  http.get(`${API}/findings/:findingId`, ({ params }) => {
    const findingId = String(params.findingId);
    const finding = fixtureCases
      .flatMap((item) => currentFindings(item.case.caseId))
      .find((item) => item.finding.findingId === findingId);
    if (!finding) {
      return HttpResponse.json({ error: { code: "FINDING_NOT_FOUND", message: "Finding not found." } }, { status: 404 });
    }
    const detail: FindingDetail = {
      ...finding,
      reviewHistory: reviewEvents.filter((event) => event.targetId === findingId),
    };
    return HttpResponse.json(detail);
  }),
  http.post(`${API}/findings/:findingId/review`, async ({ params, request }) => {
    const findingId = String(params.findingId);
    const body = await request.json() as ReviewRequest;
    const existing = fixtureCases
      .flatMap((item) => currentFindings(item.case.caseId))
      .find((item) => item.finding.findingId === findingId);
    if (!existing) {
      return HttpResponse.json({ error: { code: "FINDING_NOT_FOUND", message: "Finding not found." } }, { status: 404 });
    }
    if (body.action === "DISMISS" && !body.reason?.trim()) {
      return HttpResponse.json({ error: { code: "REASON_REQUIRED", message: "A reason is required to dismiss." } }, { status: 400 });
    }
    if (body.action === "COMMENT" && !body.comment?.trim()) {
      return HttpResponse.json({ error: { code: "COMMENT_REQUIRED", message: "A comment is required." } }, { status: 400 });
    }
    const caseId = existing.finding.caseId;
    const previousStatus = reviewStatus.get(findingId) ?? "UNREVIEWED";
    const status = nextReviewStatus(body.action, reviewStatus.get(findingId));
    if (body.action !== "COMMENT") reviewStatus.set(findingId, status);
    const event: InvestigationEvent = {
      eventId: `MOCK-EVENT-${Date.now().toString(36).toUpperCase()}`,
      caseId,
      at: new Date().toISOString(),
      actor: "fixture-analyst",
      type: body.action === "COMMENT" ? "COMMENT" : body.action === "REOPEN" ? "REOPEN" : "REVIEW",
      targetId: findingId,
      payload: reviewPayload(body, status, previousStatus),
    };
    reviewEvents.push(event);
    const detail: FindingDetail = {
      finding: existing.finding,
      reviewStatus: reviewStatus.get(findingId) ?? "UNREVIEWED",
      reviewHistory: reviewEvents.filter((item) => item.targetId === findingId),
    };
    return HttpResponse.json(detail);
  }),
  http.get(`${API}/cases/:caseId/related`, ({ params }) => {
    const caseId = String(params.caseId);
    if (!getCase(caseId)) {
      return HttpResponse.json({ error: { code: "CASE_NOT_FOUND", message: "Case not found." } }, { status: 404 });
    }
    // The recorded fixture cases share no identifier or file, so the honest mock answer is "no related cases".
    return HttpResponse.json({
      caseId,
      related: [],
      basis: "Compared exact id_number and account_number values and file hashes with every other case. A match is a lead to verify: the same person can appear in more than one case, and a match does not indicate wrongdoing. Names, addresses and amounts are not compared.",
    });
  }),
  http.get(`${API}/cases/:caseId/graph`, ({ params }) => {
    const caseId = String(params.caseId);
    const graph = fixtureGraphs[caseId as keyof typeof fixtureGraphs];
    return graph
      ? HttpResponse.json(graph)
      : HttpResponse.json({ caseId, nodes: [], edges: [] });
  }),
  http.get(`${API}/cases/:caseId/events`, ({ params }) => {
    const caseId = String(params.caseId);
    return HttpResponse.json({ caseId, events: currentEvents(caseId) });
  }),
  http.get(`${API}/cases/:caseId/integrity`, ({ params }) => {
    const caseId = String(params.caseId);
    return HttpResponse.json(emptyIntegrity(caseId));
  }),
  http.get(`${API}/cases/:caseId/dossier`, ({ params }) => {
    const result = dossier(String(params.caseId));
    return result
      ? HttpResponse.json(result)
      : HttpResponse.json({ error: { code: "CASE_NOT_FOUND", message: "Case not found." } }, { status: 404 });
  }),
];

export function nextReviewStatus(
  action: ReviewRequest["action"],
  current: ReviewStatus = "UNREVIEWED",
): ReviewStatus {
  switch (action) {
    case "CONFIRM": return "CONFIRMED";
    case "DISMISS": return "DISMISSED";
    case "INCONCLUSIVE": return "INCONCLUSIVE";
    case "REOPEN": return "UNREVIEWED";
    case "COMMENT": return current;
  }
}

export function findingById(findingId: string): Finding | undefined {
  return fixtureCases.flatMap((item) => reasoning(item.case.caseId)?.findings ?? [])
    .find((finding) => finding.findingId === findingId);
}
