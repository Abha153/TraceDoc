import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { buildDeps, createApp } from "./app.js";

const config = loadConfig(process.env);
const logger = createLogger(config.logLevel);
const app = createApp(buildDeps(config, logger));

app.listen(config.port, () => {
  logger.info({ port: config.port }, "tracedocs backend listening");
});
