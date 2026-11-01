import express, { type Express, type RequestHandler } from "express";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { createErrorHandler, notFoundHandler } from "./errors.js";
import { LoginLimiter, SessionStore } from "./auth/sessions.js";
import { createRequireAuth } from "./middleware/requireAuth.js";
import { createRequestLogger } from "./middleware/requestLogger.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";

export interface AppDeps {
  config: AppConfig;
  logger: Logger;
  sessions: SessionStore;
  limiter: LoginLimiter;
  /** Protects every route registered after it. Later batches mount their routers behind this. */
  requireAuth: RequestHandler;
}

export function buildDeps(config: AppConfig, logger: Logger): AppDeps {
  const sessions = new SessionStore(config.sessionTtlMs);
  return {
    config,
    logger,
    sessions,
    limiter: new LoginLimiter(),
    requireAuth: createRequireAuth(sessions),
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
  // Domain routers (cases, documents, findings, ...) are mounted here by later batches.
  app.use("/api/v1", api);

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));
  return app;
}
