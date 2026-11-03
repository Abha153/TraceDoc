import path from "node:path";
import type { AnalyzeResponse, DocType } from "@contracts/types";
import { JsonDir } from "./jsonDir.js";
import type { AnalysisRepository } from "./repositories.js";

/** An analyst's correction of what kind of document a page is. The machine's own classification is kept alongside. */
export interface PageOverride {
  docType: DocType;
  machineDocType: DocType;
  machineConfidence: number;
  by: string;
  at: string;
  reason?: string;
}

export interface DocumentOverrides {
  docId: string;
  pages: Record<string, PageOverride>; // keyed by page number
}

export interface OverridesRepository {
  get(docId: string): Promise<DocumentOverrides | undefined>;
  put(o: DocumentOverrides): Promise<void>;
}

export class JsonOverridesRepository implements OverridesRepository {
  private readonly store: JsonDir<DocumentOverrides>;
  constructor(recordsDir: string) {
    this.store = new JsonDir<DocumentOverrides>(path.join(recordsDir, "overrides"));
  }
  get(docId: string) {
    return this.store.get(docId);
  }
  put(o: DocumentOverrides) {
    return this.store.put(o.docId, o);
  }
}

/** The analysis with the analyst's page-type corrections applied. The input is not modified. */
export function applyOverrides(resp: AnalyzeResponse, o: DocumentOverrides | undefined): AnalyzeResponse {
  if (!o) return resp;
  return {
    ...resp,
    pages: resp.pages.map((p) => {
      const ov = o.pages[String(p.page)];
      // confidence 1: the type is now asserted by the analyst. The machine's value stays in the override record and the log.
      return ov ? { ...p, docType: ov.docType, docTypeConfidence: 1 } : p;
    }),
  };
}

/**
 * Reads see the effective analysis (machine output plus analyst corrections). Writes go to the stored machine
 * output unchanged, so an analyst's correction never overwrites what the analyzers produced.
 */
export class OverlayAnalysisRepository implements AnalysisRepository {
  constructor(
    private readonly raw: AnalysisRepository,
    private readonly overrides: OverridesRepository,
  ) {}

  put(docId: string, r: AnalyzeResponse) {
    return this.raw.put(docId, r);
  }

  async get(docId: string) {
    const r = await this.raw.get(docId);
    return r ? applyOverrides(r, await this.overrides.get(docId)) : undefined;
  }

  /** The machine output exactly as the analyzers produced it. */
  getRaw(docId: string) {
    return this.raw.get(docId);
  }
}
