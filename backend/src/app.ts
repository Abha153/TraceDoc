import express, { type Express, type RequestHandler } from "express";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { createErrorHandler, notFoundHandler } from "./errors.js";
import { LoginLimiter, SessionStore } from "./auth/sessions.js";
import { createRequireAuth } from "./middleware/requireAuth.js";
import { createRequestLogger } from "./middleware/requestLogger.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { documentsRouter } from "./routes/documents.js";
import { casesRouter } from "./routes/cases.js";
import { evidenceRouter } from "./routes/evidence.js";
import { pagesRouter } from "./routes/pages.js";
import { JsonEvidenceRepository, type EvidenceRepository } from "./repo/evidence.js";
import { NoReviews, type ReviewSource } from "./services/reviewSource.js";
import { ReasoningPipeline, createStubReasoning, engineReasoning, type ReasoningFn } from "./services/reasoning.js";
import { jobsRouter } from "./routes/jobs.js";
import { Storage } from "./services/storage.js";
import { Manifest } from "./services/manifest.js";
import { IngestService } from "./services/ingest.js";
import { JobService } from "./services/jobs.js";
import { CaseService } from "./services/cases.js";
import { UploadService } from "./services/upload.js";
import { Worker } from "./services/worker.js";
import type { AnalysisClient } from "./services/analysisClient.js";
import { MockAnalysisClient } from "./services/mockAnalysisClient.js";
import {
  JsonAnalysisRepository,
  JsonCaseRepository,
  JsonDocumentRepository,
  JsonJobRepository,
  type AnalysisRepository,
  type CaseRepository,
  type DocumentRepository,
} from "./repo/repositories.js";

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  sessions: SessionStore;
  limiter: LoginLimiter;
  /** Protects every route registered after it. Later batches mount their routers behind this. */
  requireAuth: RequestHandler;
  storage: Storage;
  manifest: Manifest;
  ingest: IngestService;
  caseRepo: CaseRepository;
  documents: DocumentRepository;
  analysis: AnalysisRepository;
  evidence: EvidenceRepository;
  reviews: ReviewSource;
  jobs: JobService;
  cases: CaseService;
  upload: UploadService;
  analysisClient: AnalysisClient;
  /** Built but not started: server.ts starts it, tests drive processNext() themselves. */
  reasoning: ReasoningPipeline;
  worker: Worker;
}

export interface DepOverrides {
  analysisClient?: AnalysisClient;
  reviews?: ReviewSource;
  reasoningFn?: ReasoningFn;
}

export function buildDeps(config: AppConfig, logger: Logger, overrides: DepOverrides = {}): AppDeps {
  const sessions = new SessionStore(config.sessionTtlMs);
  const storage = new Storage(config.dataDir);
  const manifest = new Manifest(storage.auditDir);
  const ingest = new IngestService(storage, manifest);
  const caseRepo = new JsonCaseRepository(storage.recordsDir);
  const documents = new JsonDocumentRepository(storage.recordsDir);
  const analysis = new JsonAnalysisRepository(storage.recordsDir);
  const evidence = new JsonEvidenceRepository(storage.recordsDir);
  const jobs = new JobService(new JsonJobRepository(storage.recordsDir), {
    pipelineVersion: config.pipelineVersion,
    maxAttempts: config.jobMaxAttempts,
  });
  const analysisClient =
    overrides.analysisClient ?? new MockAnalysisClient({ fixturesDir: config.fixturesDir, manifest, storage });
  const worker = new Worker({
    jobs,
    client: analysisClient,
    analysis,
    documents,
    logger,
    timeoutMs: config.jobTimeoutMs,
    pollMs: config.workerPollMs,
    retryDelayMs: config.jobRetryDelayMs,
  });
  const reason: ReasoningFn =
    overrides.reasoningFn ??
    (config.reasoningMode === "stub"
      ? createStubReasoning({
          fixturesDir: config.fixturesDir,
          fixtureIdFor: (docId) => new MockAnalysisClient({ fixturesDir: config.fixturesDir, manifest }).fixtureIdFor(docId),
        })
      : engineReasoning);
  const reasoning = new ReasoningPipeline({
    documents, jobs, analysis, evidence, reason, logger, pipelineVersion: config.pipelineVersion,
  });
  // When a job finishes and nothing else is pending for its case, reasoning runs and the result is stored.
  worker.onJobFinished((job) => reasoning.onJobFinished(job));
  return {
    config,
    logger,
    sessions,
    limiter: new LoginLimiter(),
    requireAuth: createRequireAuth(sessions, config.analystDisplayName),
    storage,
    manifest,
    ingest,
    caseRepo,
    documents,
    analysis,
    evidence,
    reviews: overrides.reviews ?? new NoReviews(),
    jobs,
    cases: new CaseService(caseRepo, documents, jobs, evidence),
    upload: new UploadService(ingest, documents, jobs, config.pipelineVersion),
    analysisClient,
    reasoning,
    worker,
  };
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(createRequestLogger(deps.logger));
  app.use(express.json({ limit: "1mb" }));

  const api = express.Router();
  api.use(healthRouter());
  api.use(authRouter(deps));
  api.use(casesRouter(deps.cases, deps.requireAuth, deps.reasoning));
  api.use(
    documentsRouter({
      upload: deps.upload,
      cases: deps.cases,
      documents: deps.documents,
      analysis: deps.analysis,
      requireAuth: deps.requireAuth,
      maxUploadBytes: deps.config.maxUploadBytes,
    }),
  );
  api.use(jobsRouter(deps.jobs, deps.requireAuth));
  api.use(
    evidenceRouter({
      cases: deps.cases,
      evidence: deps.evidence,
      documents: deps.documents,
      analysis: deps.analysis,
      reviews: deps.reviews,
      requireAuth: deps.requireAuth,
    }),
  );
  api.use(pagesRouter({ storage: deps.storage, documents: deps.documents, analysis: deps.analysis, requireAuth: deps.requireAuth }));
  // More domain routers (findings, review, graph, ...) are mounted here by later batches.
  app.use("/api/v1", api);

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));
  return app;
}
