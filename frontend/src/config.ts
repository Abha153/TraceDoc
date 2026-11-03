function positiveNumber(name: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number.`);
  }
  return parsed;
}

export const apiBase = (import.meta.env.VITE_API_BASE || "/api/v1").replace(/\/+$/, "");
export const maxUploadMegabytes = positiveNumber("VITE_MAX_UPLOAD_MB", import.meta.env.VITE_MAX_UPLOAD_MB, 20);
export const jobPollIntervalMs = positiveNumber("VITE_JOB_POLL_MS", import.meta.env.VITE_JOB_POLL_MS, 1100);

/** Fixture (MSW) mode is the default; set VITE_USE_MOCKS=false to talk to the real backend. */
export const mockMode = import.meta.env.VITE_USE_MOCKS !== "false";

/** Canonical page render served by the backend (GET /documents/:docId/pages/:n/render). */
export function pageRenderUrl(docId: string, page: number): string {
  return `${apiBase}/documents/${encodeURIComponent(docId)}/pages/${page}/render`;
}
