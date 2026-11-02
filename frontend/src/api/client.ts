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
  Session,
  UploadResponse,
} from "../../../contracts/api";
import type { DocumentDetail } from "../../../contracts/api";
import type { ReviewRequest } from "../../../contracts/api";
import type { Job } from "../../../contracts/types";
import { apiBase } from "../config";

export interface UploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    credentials: "include",
    ...init,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as
      | { error?: { message?: string } }
      | null;
    throw new Error(body?.error?.message ?? `Request failed (${response.status})`);
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
  listCases: () => request<Case[]>("/cases"),
  createCase: (body: CreateCaseRequest) => request<Case>("/cases", jsonBody(body)),
  getCase: (caseId: string) => request<CaseSummary>(`/cases/${encodeURIComponent(caseId)}`),
  getDocument: (docId: string) => request<DocumentDetail>(`/documents/${encodeURIComponent(docId)}`),
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
  graph: (caseId: string) => request<GraphResponse>(`/cases/${encodeURIComponent(caseId)}/graph`),
  events: (caseId: string) => request<EventsResponse>(`/cases/${encodeURIComponent(caseId)}/events`),
  integrity: (caseId: string) => request<IntegrityReport>(`/cases/${encodeURIComponent(caseId)}/integrity`),
  dossier: (caseId: string) => request<DossierJson>(`/cases/${encodeURIComponent(caseId)}/dossier?format=json`),
};
