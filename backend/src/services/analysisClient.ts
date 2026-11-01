import type { AnalyzeResponse } from "@contracts/types";

/** The platform's only view of the analysis service. B11 adds the real HTTP implementation. */
export interface AnalysisClient {
  analyze(docId: string, opts?: { signal?: AbortSignal }): Promise<AnalyzeResponse>;
}

/** Throw this when retrying cannot help (for example, no recorded analysis exists for the file). */
export class PermanentAnalysisError extends Error {}
export class AnalysisTimeoutError extends Error {}
