import { randomBytes } from "node:crypto";

export interface Session {
  analystId: string;
  expiresAt: number;
}

/** In-memory single-analyst session store. Sessions end on restart (prototype scope). */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(analystId: string): string {
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { analystId, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  get(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    return s;
  }

  destroy(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }
}

/** Blocks repeated failed logins from one client within a window. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(key) ?? []).filter((t) => t > cutoff);
    this.failures.set(key, list);
    return list;
  }

  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.maxFailures;
  }

  recordFailure(key: string): void {
    this.recent(key).push(this.now());
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

export const SESSION_COOKIE = "tracedocs_session"; // name fixed by contracts/openapi.yaml

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(raw);
    } catch {
      out[k] = raw;
    }
  }
  return out;
}
