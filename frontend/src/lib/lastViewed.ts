import { useEffect } from "react";

const KEY = "tracedocs.lastViewed";
export const LAST_VIEWED_EVENT = "tracedocs:last-viewed";

export interface LastViewed {
  path: string;
  label: string;
  caseId?: string;
  docId?: string;
  at: string;
}

export function readLastViewed(): LastViewed | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value === "object" && value !== null && "path" in value && "label" in value
      && typeof value.path === "string" && typeof value.label === "string" && value.path.startsWith("/")) {
      return value as LastViewed;
    }
  } catch {
    localStorage.removeItem(KEY);
  }
  return null;
}

export function writeLastViewed(entry: Omit<LastViewed, "at">): void {
  localStorage.setItem(KEY, JSON.stringify({ ...entry, at: new Date().toISOString() }));
  window.dispatchEvent(new Event(LAST_VIEWED_EVENT));
}

/** Pages call this once their data is loaded so the top bar can resume exactly here. */
export function useRecordLastViewed(entry: Omit<LastViewed, "at"> | null): void {
  const key = entry ? `${entry.path}|${entry.label}` : "";
  useEffect(() => {
    if (entry) writeLastViewed(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
