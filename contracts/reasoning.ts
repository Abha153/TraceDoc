/**
 * The single entry point between the backend platform and the reasoning engine.
 * Implemented by backend/src/engine/index.ts. Pure and deterministic: no I/O, same input, same output.
 */
import type {
  AnalyzeResponse,
  DocumentAssertion,
  Entity,
  Finding,
  PriorityOutput,
  RegionEvent,
} from "./types";

export interface ReasoningInput {
  caseId: string;
  documents: AnalyzeResponse[];
}

export interface ReasoningOutput {
  assertions: DocumentAssertion[];
  entities: Entity[];
  findings: Finding[];
  events: RegionEvent[];
  priority: PriorityOutput;
}

/** runReasoning(input: ReasoningInput): ReasoningOutput */
export type RunReasoning = (input: ReasoningInput) => ReasoningOutput;
