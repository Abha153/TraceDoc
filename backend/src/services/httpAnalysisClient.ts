import { readFileSync } from "node:fs";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import type { AnalyzeResponse } from "@contracts/types";
import type { Logger } from "../logger.js";
import { AnalysisTimeoutError, PermanentAnalysisError, type AnalysisClient } from "./analysisClient.js";

/** Returns a description of what is wrong with a response, or undefined if it matches contracts/analyze.schema.json. */
export type AnalyzeValidator = (data: unknown) => string | undefined;

export function createAnalyzeValidator(contractsDir: string): AnalyzeValidator {
  const file = path.join(contractsDir, "analyze.schema.json");
  let schema: object;
  try {
    schema = JSON.parse(readFileSync(file, "utf8")) as object;
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${(err as Error).message}. Set CONTRACTS_DIR to the contracts folder.`);
  }
  const ajv = new Ajv({ allErrors: false, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  return (data) => {
    if (validate(data)) return undefined;
    return (validate.errors ?? []).slice(0, 3).map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`).join("; ");
  };
}

/**
 * The contract documents value ranges that the generated JSON schema does not enforce (types.ts: "bbox = [x, y, w, h], each
 * normalized 0..1 against the canonical render"; confidences are 0..1). A response that breaks them would break the crops,
 * the graph and the engine's thresholds, so it is rejected here. Returns the first problem, or undefined.
 */
export function rangeProblem(r: AnalyzeResponse): string | undefined {
  const unit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  const pageNumbers = new Set(r.pages.map((p) => p.page));
  const checkRegion = (where: string, g: { docId: string; page: number; bbox: number[] }): string | undefined => {
    const [x, y, w, h] = g.bbox as [number, number, number, number];
    if (![x, y, w, h].every(unit)) return `${where}: bbox ${JSON.stringify(g.bbox)} is outside 0..1`;
    if (x + w > 1 + 1e-6 || y + h > 1 + 1e-6) return `${where}: bbox ${JSON.stringify(g.bbox)} extends past the page edge`;
    if (g.docId !== r.docId) return `${where}: region belongs to ${g.docId}, not ${r.docId}`;
    if (!pageNumbers.has(g.page)) return `${where}: region is on page ${g.page}, which this document does not have`;
    return undefined;
  };
  for (const p of r.pages) if (!unit(p.docTypeConfidence)) return `page ${p.page}: docTypeConfidence ${p.docTypeConfidence} is outside 0..1`;
  for (const f of r.fields) {
    if (!unit(f.ocrConfidence) || !unit(f.extractionConfidence)) return `field ${f.fieldId}: a confidence is outside 0..1`;
    const bad = checkRegion(`field ${f.fieldId}`, f.region);
    if (bad) return bad;
  }
  for (const s of r.signals) {
    if (!unit(s.confidence)) return `signal ${s.signalId}: confidence ${s.confidence} is outside 0..1`;
    for (const reg of s.regions) {
      const bad = checkRegion(`signal ${s.signalId}`, reg);
      if (bad) return bad;
    }
  }
  return undefined;
}

export interface HttpAnalysisClientOptions {
  baseUrl: string;
  /** Per call (every attempt gets its own). */
  timeoutMs: number;
  retryDelayMs: number;
  validate: AnalyzeValidator;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

/** Statuses that mean "the service (or something in front of it) is not ready", worth one more try. */
const RETRYABLE_STATUS = new Set([502, 503, 504]);

/**
 * The real analysis service (ocr-service, Python). POST {baseUrl}/analyze with {docId}; the service reads the original
 * from the shared DATA_DIR and answers with an AnalyzeResponse, which is validated against contracts/analyze.schema.json.
 *
 * Failures, and what the job does with them (B3):
 *  - cannot connect, connection dropped, 502/503/504: tried once more, then a transient error (the job is re-queued);
 *  - no answer within the timeout: AnalysisTimeoutError (transient, not retried here: the wait was already long);
 *  - 404/409/415/422 and other 4xx: PermanentAnalysisError (retrying the same file cannot help), with the service's reason;
 *  - 5xx: transient error;
 *  - an answer that does not match the schema or names another document: PermanentAnalysisError. A bad answer is never used.
 * Analyzers that fail INSIDE the service come back as ERROR/UNAVAILABLE in `analyzerStatuses` and the job becomes
 * PARTIAL (or FAILED if none succeeded): that mapping is JobService.complete.
 */
export class HttpAnalysisClient implements AnalysisClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly o: HttpAnalysisClientOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  async analyze(docId: string, opts: { signal?: AbortSignal } = {}): Promise<AnalyzeResponse> {
    const body = JSON.stringify({ docId });
    for (let attempt = 1; ; attempt++) {
      const timeout = AbortSignal.timeout(this.o.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.o.baseUrl}/analyze`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body,
          signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err; // the caller gave up (its own timeout): not ours to retry
        if (timeout.aborted) throw new AnalysisTimeoutError(`the analysis service did not answer within ${this.o.timeoutMs} ms`);
        if (attempt === 1) {
          this.o.logger?.warn({ docId, reason: reason(err) }, "analysis service unreachable, retrying once");
          await this.pause(opts.signal);
          continue;
        }
        throw new Error(`the analysis service could not be reached at ${this.o.baseUrl} (${reason(err)})`);
      }
      if (RETRYABLE_STATUS.has(res.status) && attempt === 1) {
        await res.arrayBuffer().catch(() => undefined);
        this.o.logger?.warn({ docId, status: res.status }, "analysis service not ready, retrying once");
        await this.pause(opts.signal);
        continue;
      }
      return this.handle(res, docId, opts.signal, timeout);
    }
  }

  /** GET /health, for a startup message. Never throws. */
  async ping(): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.fetchImpl(`${this.o.baseUrl}/health`, { signal: AbortSignal.timeout(3000) });
      return res.ok ? { ok: true, detail: await res.text() } : { ok: false, detail: `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, detail: reason(err) };
    }
  }

  private async handle(res: Response, docId: string, caller: AbortSignal | undefined, timeout: AbortSignal): Promise<AnalyzeResponse> {
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (caller?.aborted) throw err;
      if (timeout.aborted) throw new AnalysisTimeoutError(`the analysis service did not finish answering within ${this.o.timeoutMs} ms`);
      throw new Error(`the connection to the analysis service was lost while reading the answer (${reason(err)})`);
    }

    if (res.status >= 500) throw new Error(`the analysis service failed (HTTP ${res.status}): ${detail(text)}`);
    if (res.status === 404) {
      throw new PermanentAnalysisError(
        `the analysis service cannot find the original of ${docId} (HTTP 404). The backend and the service must use the same DATA_DIR: ` +
          "the service reads DATA_DIR/evidence/<docId>/original.<ext> that the backend wrote",
      );
    }
    if (res.status !== 200) throw new PermanentAnalysisError(`the analysis service rejected ${docId} (HTTP ${res.status}): ${detail(text)}`);

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new PermanentAnalysisError("the analysis service answered with something that is not JSON");
    }
    const problem = this.o.validate(json);
    if (problem) throw new PermanentAnalysisError(`the analysis service's answer does not match contracts/analyze.schema.json: ${problem}`);
    const response = json as AnalyzeResponse;
    const range = rangeProblem(response);
    if (range) throw new PermanentAnalysisError(`the analysis service's answer breaks the value ranges the contract documents: ${range}`);
    if (response.docId !== docId) throw new PermanentAnalysisError(`the analysis service answered for ${response.docId} when asked about ${docId}`);
    return response;
  }

  private pause(signal?: AbortSignal): Promise<void> {
    const ms = this.o.retryDelayMs;
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
    });
  }
}

function reason(err: unknown): string {
  const e = err as { cause?: { code?: string; message?: string }; code?: string; message?: string };
  return e.cause?.code ?? e.cause?.message ?? e.code ?? e.message ?? String(err);
}

/** FastAPI errors are {"detail": "..."} or {"detail": [{"msg": ...}]}; anything else is shown as plain text. */
function detail(text: string): string {
  let out = text;
  try {
    const d = (JSON.parse(text) as { detail?: unknown }).detail;
    if (typeof d === "string") out = d;
    else if (Array.isArray(d)) out = d.map((x) => (x as { msg?: string }).msg ?? JSON.stringify(x)).join("; ");
  } catch {
    /* not JSON */
  }
  return out.replace(/\s+/g, " ").slice(0, 300);
}
