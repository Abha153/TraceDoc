import { copyFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { AnalyzeResponse } from "@contracts/types";
import type { CaseFixture } from "@contracts/api";
import { PermanentAnalysisError, type AnalysisClient } from "./analysisClient.js";
import type { Manifest } from "./manifest.js";
import { remapId } from "./remap.js";
import type { Storage } from "./storage.js";

export interface MockOptions {
  fixturesDir: string;
  manifest: Manifest;
  /** Force a mapping from an uploaded docId to a fixture docId (tests). */
  overrides?: Map<string, string>;
  /** When given, the recorded page images are copied to derived/<docId>/page-<n>.png, as the real service would. */
  storage?: Storage;
  delayMs?: number;
}

/**
 * Answers from contracts/fixtures/analyze/. The uploaded file is matched to a fixture by SHA-256
 * (the fixtures' originals/ files are the "uploads"), and the recorded response is re-labelled with
 * the server-generated docId. A file that matches no fixture is a permanent error, never a clean result.
 */
export class MockAnalysisClient implements AnalysisClient {
  private bySha?: Map<string, string>;

  constructor(private readonly opts: MockOptions) {}

  private async shaIndex(): Promise<Map<string, string>> {
    if (this.bySha) return this.bySha;
    const map = new Map<string, string>();
    for (const name of (await readdir(this.opts.fixturesDir)).filter((n) => /^CASE-.*\.case\.json$/.test(n))) {
      const fx = JSON.parse(await readFile(path.join(this.opts.fixturesDir, name), "utf8")) as CaseFixture;
      for (const d of fx.documents) map.set(d.sha256, d.docId);
    }
    return (this.bySha = map);
  }

  /** Which fixture document a stored upload corresponds to, if any. */
  async fixtureIdFor(docId: string): Promise<string | undefined> {
    const forced = this.opts.overrides?.get(docId);
    if (forced) return forced;
    const entry = (await this.opts.manifest.list()).find((e) => e.docId === docId);
    return entry ? (await this.shaIndex()).get(entry.sha256) : undefined;
  }

  async analyze(docId: string, opts: { signal?: AbortSignal } = {}): Promise<AnalyzeResponse> {
    if (this.opts.delayMs) await new Promise((r) => setTimeout(r, this.opts.delayMs));
    opts.signal?.throwIfAborted();
    const fixtureId = await this.fixtureIdFor(docId);
    if (!fixtureId) {
      throw new PermanentAnalysisError(
        "mock analysis has no recorded result for this file (upload a file from contracts/fixtures/originals, or set ANALYSIS_MODE for the real service)",
      );
    }
    const file = path.join(this.opts.fixturesDir, "analyze", `${fixtureId}.json`);
    const recorded = JSON.parse(await readFile(file, "utf8")) as AnalyzeResponse;
    const response = remapId(recorded, fixtureId, docId);
    if (this.opts.storage) {
      await this.opts.storage.derivedDir(docId);
      for (const p of response.pages) {
        const src = path.join(this.opts.fixturesDir, "pages", `${fixtureId}-page-${p.page}.png`);
        await copyFile(src, this.opts.storage.derivedFile(docId, `page-${p.page}.png`)).catch(() => undefined);
      }
    }
    return response;
  }
}
