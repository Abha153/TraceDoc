import { z } from "zod";

const boolFromString = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATA_DIR: z.string().min(1).default("./data"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  PIPELINE_VERSION: z.string().min(1).default("0.1.0"),
  REASONING_MODE: z.enum(["engine", "stub"]).default("engine"), // stub: recorded fixture output, mock analysis only
  ANALYSIS_MODE: z.enum(["mock", "http"]).default("mock"), // http: the real Python service (ocr-service)
  ANALYSIS_URL: z.string().url().default("http://127.0.0.1:8000"),
  ANALYSIS_TIMEOUT_MS: z.coerce.number().int().positive().default(110_000), // per call; keep below JOB_TIMEOUT_MS
  ANALYSIS_RETRY_DELAY_MS: z.coerce.number().int().min(0).default(500),
  CONTRACTS_DIR: z.string().min(1).default("../contracts"), // analyze.schema.json is read from here
  FIXTURES_DIR: z.string().min(1).default("../contracts/fixtures"),
  JOB_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  JOB_RETRY_DELAY_MS: z.coerce.number().int().min(0).default(1000),
  WORKER_POLL_MS: z.coerce.number().int().min(10).default(500),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  ANALYST_ID: z.string().min(1).default("analyst"),
  ANALYST_DISPLAY_NAME: z.string().min(1).default("Analyst"),
  ANALYST_PASSWORD_HASH: z
    .string()
    .regex(/^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/, "must be produced by `npm run hash-password`"),
  RETENTION_DAYS: z.coerce.number().int().positive().max(3650).default(90), // reported by /compliance/retention-policy; nothing is purged
  SESSION_TTL_HOURS: z.coerce.number().positive().max(24 * 30).default(8),
  COOKIE_SECURE: boolFromString.optional(),
});

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: string;
  dataDir: string;
  pipelineVersion: string;
  reasoningMode: "engine" | "stub";
  analysisMode: "mock" | "http";
  analysisUrl: string;
  analysisTimeoutMs: number;
  analysisRetryDelayMs: number;
  contractsDir: string;
  fixturesDir: string;
  jobTimeoutMs: number;
  jobMaxAttempts: number;
  jobRetryDelayMs: number;
  workerPollMs: number;
  maxUploadBytes: number;
  analystId: string;
  analystDisplayName: string;
  analystPasswordHash: string;
  retentionDays: number;
  sessionTtlMs: number;
  cookieSecure: boolean;
}

export class ConfigError extends Error {}

/** Validates an env-like object. Pure, so tests can pass their own. */
export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  // Treat empty strings as unset so `.env` files with blank values behave sensibly.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid environment: ${detail}`);
  }
  const e = parsed.data;
  if (e.REASONING_MODE === "stub" && e.ANALYSIS_MODE !== "mock") {
    throw new ConfigError("Invalid environment: REASONING_MODE=stub only works with ANALYSIS_MODE=mock (the stub matches documents to fixtures by hash)");
  }
  if (e.ANALYSIS_MODE === "http" && e.ANALYSIS_TIMEOUT_MS >= e.JOB_TIMEOUT_MS) {
    throw new ConfigError("Invalid environment: ANALYSIS_TIMEOUT_MS must be smaller than JOB_TIMEOUT_MS, or the job timeout hides the service's own error");
  }
  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    dataDir: e.DATA_DIR,
    pipelineVersion: e.PIPELINE_VERSION,
    reasoningMode: e.REASONING_MODE,
    analysisMode: e.ANALYSIS_MODE,
    analysisUrl: e.ANALYSIS_URL.replace(/\/+$/, ""),
    analysisTimeoutMs: e.ANALYSIS_TIMEOUT_MS,
    analysisRetryDelayMs: e.ANALYSIS_RETRY_DELAY_MS,
    contractsDir: e.CONTRACTS_DIR,
    fixturesDir: e.FIXTURES_DIR,
    jobTimeoutMs: e.JOB_TIMEOUT_MS,
    jobMaxAttempts: e.JOB_MAX_ATTEMPTS,
    jobRetryDelayMs: e.JOB_RETRY_DELAY_MS,
    workerPollMs: e.WORKER_POLL_MS,
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
    analystId: e.ANALYST_ID,
    analystDisplayName: e.ANALYST_DISPLAY_NAME,
    analystPasswordHash: e.ANALYST_PASSWORD_HASH,
    retentionDays: e.RETENTION_DAYS,
    sessionTtlMs: e.SESSION_TTL_HOURS * 3_600_000,
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === "production",
  };
}
