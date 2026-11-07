import type {
  AssertionsResponse,
  Case,
  CaseSummary,
  CreateCaseRequest,
  DossierJson,
  EntitiesResponse,
  EventsResponse,
  FindingDetail,
  FindingsResponse,
  GraphResponse,
  IntegrityReport,
  LoginRequest,
  RelatedCasesResponse,
  Session,
  UploadResponse,
} from "../../../contracts/api";
import type { DocumentDetail } from "../../../contracts/api";
import type { ReclassifyRequest, ReviewRequest } from "../../../contracts/api";
import type { Job } from "../../../contracts/types";
import { apiBase } from "../config";

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

/** Error carrying the HTTP status so callers can tell "route not available" (404) from a real failure. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/** Dossier as served by GET /cases/:id/dossier, or composed from the live read routes while that route does not exist (B14). */
export type DossierView = Omit<DossierJson, "integrity"> & { integrity?: IntegrityReport; composedFromLiveRoutes?: boolean };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as
      | { error?: { message?: string } }
      | null;
    throw new ApiError(body?.error?.message ?? `Request failed (${response.status})`, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  };
}

export const api = {
  login: (body: LoginRequest) => request<Session>("/auth/login", jsonBody(body)),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  // GET /cases returns CaseSummary[] (contracts/openapi.yaml). listCases keeps the plain Case view for selectors.
  listCaseSummaries: () => request<CaseSummary[]>("/cases"),
  listCases: async (): Promise<Case[]> => (await request<CaseSummary[]>("/cases")).map((summary) => summary.case),
  createCase: (body: CreateCaseRequest) => request<Case>("/cases", jsonBody(body)),
  getCase: (caseId: string) => request<CaseSummary>(`/cases/${encodeURIComponent(caseId)}`),
  getDocument: (docId: string) => request<DocumentDetail>(`/documents/${encodeURIComponent(docId)}`),
  /** PATCH /documents/:docId/pages/:n/type. The backend logs the correction and queues a re-run, returned as a Job. */
  reclassify: (docId: string, page: number, body: ReclassifyRequest) =>
    request<Job>(`/documents/${encodeURIComponent(docId)}/pages/${page}/type`, { ...jsonBody(body), method: "PATCH" }),
  getJob: (jobId: string) => request<Job>(`/jobs/${encodeURIComponent(jobId)}`),
  upload: (caseId: string, files: File[], onProgress?: (progress: UploadProgress) => void) => {
    const body = new FormData();
    files.forEach((file) => body.append("files", file));
    return new Promise<UploadResponse>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${apiBase}/cases/${encodeURIComponent(caseId)}/documents`);
      xhr.withCredentials = true;
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) {
          onProgress?.({
            loaded: event.loaded,
            total: event.total,
            percent: Math.round((event.loaded / event.total) * 100),
          });
        }
      });
      xhr.addEventListener("load", () => {
        if (xhr.status < 200 || xhr.status >= 300) {
          try {
            const body = JSON.parse(xhr.responseText) as { error?: { message?: string } };
            reject(new Error(body.error?.message ?? `Request failed (${xhr.status})`));
          } catch (error) {
            if (error instanceof SyntaxError) {
              reject(new Error(`Request failed (${xhr.status})`));
            } else {
              reject(error);
            }
          }
          return;
        }
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResponse);
        } catch {
          reject(new Error("The server returned an invalid upload response."));
        }
      });
      xhr.addEventListener("error", () => reject(new Error("The upload could not reach the server.")));
      xhr.addEventListener("abort", () => reject(new Error("The upload was cancelled.")));
      xhr.send(body);
    });
  },
  assertions: (caseId: string) => request<AssertionsResponse>(`/cases/${encodeURIComponent(caseId)}/assertions`),
  entities: (caseId: string) => request<EntitiesResponse>(`/cases/${encodeURIComponent(caseId)}/entities`),
  findings: (caseId: string) => request<FindingsResponse>(`/cases/${encodeURIComponent(caseId)}/findings`),
  finding: (findingId: string) => request<FindingDetail>(`/findings/${encodeURIComponent(findingId)}`),
  review: (findingId: string, body: ReviewRequest) =>
    request<FindingDetail>(`/findings/${encodeURIComponent(findingId)}/review`, jsonBody(body)),
  related: (caseId: string) => request<RelatedCasesResponse>(`/cases/${encodeURIComponent(caseId)}/related`),
  graph: (caseId: string) => request<GraphResponse>(`/cases/${encodeURIComponent(caseId)}/graph`),
  events: (caseId: string) => request<EventsResponse>(`/cases/${encodeURIComponent(caseId)}/events`),
  integrity: async (caseId: string) => {
    try {
      return await request<IntegrityReport>(`/cases/${encodeURIComponent(caseId)}/integrity`);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw new Error("The integrity check is not available on this backend.");
      }
      throw error;
    }
  },
  /** GET /cases/:id/dossier (PDF). Returns null when the route does not exist so the caller can fall back to a local export. */
  dossierPdf: async (caseId: string): Promise<Blob | null> => {
    const response = await fetch(`${apiBase}/cases/${encodeURIComponent(caseId)}/dossier`, { credentials: "include" });
    if (response.status === 404) return null;
    if (!response.ok) throw new ApiError("The dossier could not be exported.", response.status);
    return response.blob();
  },
  dossier: async (caseId: string): Promise<DossierView> => {
    try {
      return await request<DossierJson>(`/cases/${encodeURIComponent(caseId)}/dossier?format=json`);
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 404) throw error;
    }
    // The dossier route (B14) is not mounted: compose the same content from routes that exist, and say so.
    const [summary, assertions, entities, findings, events, integrity] = await Promise.all([
      api.getCase(caseId),
      api.assertions(caseId),
      api.entities(caseId),
      api.findings(caseId),
      api.events(caseId),
      api.integrity(caseId).catch(() => undefined), // B12 may be absent on an older backend; recorded as a limitation below
    ]);
    return {
      caseId,
      generatedAt: new Date().toISOString(),
      summary,
      assertions: assertions.assertions,
      entities: entities.entities,
      findings: findings.findings,
      reviewHistory: events.events.filter((event) => ["REVIEW", "COMMENT", "REOPEN"].includes(event.type)),
      analyzerStatuses: Object.fromEntries(summary.documents.map((document) => [document.docId, document.processing])),
      integrity,
      limitations: [
        "The dossier export route (batch B14) is not available on this backend; this view is composed from the live read routes.",
        ...(integrity ? [] : ["The document integrity check is not available on this backend, so file hashes have not been re-verified."]),
      ],
      composedFromLiveRoutes: true,
    };
  },
};
