import { loadConfig, type AppConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { buildDeps, createApp, type AppDeps } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";

export const TEST_USER = "analyst";
export const TEST_PASSWORD = "correct horse battery staple";

let cachedHash: string | undefined;

export async function testConfig(overrides: Record<string, string> = {}): Promise<AppConfig> {
  cachedHash ??= await hashPassword(TEST_PASSWORD);
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    ANALYST_ID: TEST_USER,
    ANALYST_PASSWORD_HASH: cachedHash,
    ...overrides,
  });
}

export async function testApp(overrides: Record<string, string> = {}) {
  const config = await testConfig(overrides);
  const deps: AppDeps = buildDeps(config, createLogger("silent"));
  return { app: createApp(deps), deps, config };
}
