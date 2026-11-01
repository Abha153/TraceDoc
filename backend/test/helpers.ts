import { loadConfig, type AppConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { buildDeps, createApp, type AppDeps, type DepOverrides } from "../src/app.js";
import { fileURLToPath } from "node:url";
import { hashPassword } from "../src/auth/password.js";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

export const TEST_USER = "analyst";
export const TEST_PASSWORD = "correct horse battery staple";

let cachedHash: string | undefined;

export async function testConfig(overrides: Record<string, string> = {}): Promise<AppConfig> {
  cachedHash ??= await hashPassword(TEST_PASSWORD);
  const dataDir = overrides.DATA_DIR ?? (await mkdtemp(path.join(tmpdir(), "tracedocs-test-")));
  return loadConfig({
    DATA_DIR: dataDir,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    ANALYST_ID: TEST_USER,
    ANALYST_PASSWORD_HASH: cachedHash,
    ...overrides,
  });
}

export const FIXTURES_DIR = fileURLToPath(new URL("../../contracts/fixtures", import.meta.url));

export async function testApp(overrides: Record<string, string> = {}, depOverrides: DepOverrides = {}) {
  const config = await testConfig({ FIXTURES_DIR, JOB_RETRY_DELAY_MS: "0", ...overrides });
  const deps: AppDeps = buildDeps(config, createLogger("silent"), depOverrides);
  return { app: createApp(deps), deps, config };
}

export async function loggedInAgent(app: Parameters<typeof request>[0]) {
  const agent = request.agent(app);
  await agent.post("/api/v1/auth/login").send({ username: TEST_USER, password: TEST_PASSWORD }).expect(200);
  return agent;
}

// Minimal valid-looking headers for each supported type.
export const PDF_BYTES = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
export const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
export const JPG_BYTES = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("rest")]);
export const TIFF_LE_BYTES = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.from("rest")]);
export const TIFF_BE_BYTES = Buffer.concat([Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), Buffer.from("rest")]);
export const EXE_BYTES = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(200, 0x90)]);

/** A logged-in agent with CASE-001 already created (uploads need an existing case). */
export async function agentWithCase(app: Parameters<typeof request>[0]) {
  const agent = await loggedInAgent(app);
  await agent.post("/api/v1/cases").send({ title: "Test case" }).expect(201);
  return agent;
}

/** Runs the worker until no queued job is left (retries included). */
export async function drain(deps: AppDeps, max = 50): Promise<void> {
  for (let i = 0; i < max; i++) if (!(await deps.worker.processNext())) return;
  throw new Error("worker did not drain");
}

// ---- contract validation: every API body is checked against contracts/contracts.schema.json
const bundle = JSON.parse(readFileSync(path.join(FIXTURES_DIR, "..", "contracts.schema.json"), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

export function expectMatchesContract(type: string, body: unknown): void {
  const validate = ajv.compile({ definitions: bundle.definitions, $ref: `#/definitions/${type}` });
  if (!validate(body)) {
    throw new Error(`${type} does not match contracts.schema.json:\n${JSON.stringify(validate.errors?.slice(0, 5), null, 2)}`);
  }
}

// ---- fixture cases loaded through the real upload + worker path
import { readFile } from "node:fs/promises";
import type { ReasoningOutput } from "@contracts/reasoning";
import type { UploadResponse } from "@contracts/api";
import { remapIds } from "../src/services/remap.js";

export async function fixtureJson<T>(rel: string): Promise<T> {
  return JSON.parse(await readFile(path.join(FIXTURES_DIR, rel), "utf8")) as T;
}

/**
 * Uploads a fixture case's original files into the (already created) case, runs the worker, and returns the
 * mapping from fixture document ids (D-01) to the server-generated ids.
 */
export async function uploadFixtureDocs(
  deps: AppDeps,
  agent: Awaited<ReturnType<typeof loggedInAgent>>,
  caseId: string,
  files: string[],
): Promise<Record<string, string>> {
  const req = agent.post(`/api/v1/cases/${caseId}/documents`);
  for (const f of files) req.attach("files", await readFile(path.join(FIXTURES_DIR, "originals", f)), f);
  const up = (await req.expect(202)).body as UploadResponse;
  await drain(deps);
  return Object.fromEntries(files.map((f, i) => [f.replace(/\.[a-z]+$/, ""), up.documents[i]!.docId]));
}

/** Stores the fixture reasoning output for a case (re-labelled with real document ids) as a new generation. */
export async function storeFixtureReasoning(deps: AppDeps, caseId: string, mapping: Record<string, string>) {
  const output = remapIds(await fixtureJson<ReasoningOutput>(`${caseId}.reasoning.json`), mapping);
  const signals = [];
  for (const real of Object.values(mapping)) signals.push(...((await deps.analysis.get(real))?.signals ?? []));
  return deps.evidence.put(caseId, output, signals);
}
