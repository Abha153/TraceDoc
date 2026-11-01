import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { buildDeps, createApp } from "./app.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const deps = buildDeps(config, logger);
const app = createApp(deps);

// Jobs left RUNNING by a previous process go back in the queue before the worker starts.
const recovered = await deps.jobs.recoverRunning();
if (recovered > 0) logger.warn({ recovered }, "re-queued jobs interrupted by a restart");
deps.worker.start();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, analysisMode: config.analysisMode }, "tracedocs backend listening");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    logger.info({ sig }, "shutting down");
    await deps.worker.stop();
    server.close(() => process.exit(0));
  });
}
