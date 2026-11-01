import pino, { type Logger } from "pino";

export type { Logger };

export function createLogger(level: string): Logger {
  return pino({
    level,
    // Never write credentials or session cookies to logs.
    redact: ["req.headers.cookie", "req.headers.authorization", "password"],
  });
}
