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
