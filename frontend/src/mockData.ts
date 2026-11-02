import caseOneJson from "../../contracts/fixtures/CASE-001.case.json";
import caseTwoJson from "../../contracts/fixtures/CASE-002.case.json";
import graphOneJson from "../../contracts/fixtures/CASE-001.graph.json";
import graphTwoJson from "../../contracts/fixtures/CASE-002.graph.json";
import reasoningOneJson from "../../contracts/fixtures/CASE-001.reasoning.json";
import reasoningTwoJson from "../../contracts/fixtures/CASE-002.reasoning.json";
import analyzeOneJson from "../../contracts/fixtures/analyze/D-01.json";
import analyzeTwoJson from "../../contracts/fixtures/analyze/D-02.json";
import analyzeThreeJson from "../../contracts/fixtures/analyze/D-03.json";
import analyzeElevenJson from "../../contracts/fixtures/analyze/D-11.json";
import analyzeTwelveJson from "../../contracts/fixtures/analyze/D-12.json";
import analyzeThirteenJson from "../../contracts/fixtures/analyze/D-13.json";
import type {
  AnalyzeResponse,
  DocumentRecord,
  InvestigationEvent,
  Job,
} from "../../contracts/types";
import type {
  Case,
  CaseFixture,
  GraphResponse,
  IntegrityReport,
} from "../../contracts/api";
import type { ReasoningOutput } from "../../contracts/reasoning";
import { parseContractFixture } from "./parseContractFixture";

export const fixtureCases = [
  parseContractFixture<CaseFixture>("CaseFixture", caseOneJson),
  parseContractFixture<CaseFixture>("CaseFixture", caseTwoJson),
];

export const fixtureReasoning: Record<string, ReasoningOutput> = {
  "CASE-001": parseContractFixture<ReasoningOutput>("ReasoningOutput", reasoningOneJson),
  "CASE-002": parseContractFixture<ReasoningOutput>("ReasoningOutput", reasoningTwoJson),
};

export const fixtureGraphs: Record<string, GraphResponse> = {
  "CASE-001": parseContractFixture<GraphResponse>("GraphResponse", graphOneJson),
  "CASE-002": parseContractFixture<GraphResponse>("GraphResponse", graphTwoJson),
};

export const fixtureAnalysis: Record<string, AnalyzeResponse> = {
  "D-01": parseContractFixture<AnalyzeResponse>("AnalyzeResponse", analyzeOneJson),
  "D-02": parseContractFixture<AnalyzeResponse>("AnalyzeResponse", analyzeTwoJson),
  "D-03": parseContractFixture<AnalyzeResponse>("AnalyzeResponse", analyzeThreeJson),
  "D-11": parseContractFixture<AnalyzeResponse>("AnalyzeResponse", analyzeElevenJson),
  "D-12": parseContractFixture<AnalyzeResponse>("AnalyzeResponse", analyzeTwelveJson),
  "D-13": parseContractFixture<AnalyzeResponse>("AnalyzeResponse", analyzeThirteenJson),
};

export const fixturePageUrls: Record<string, string> = {
  "D-01": new URL("../../contracts/fixtures/pages/D-01-page-1.png", import.meta.url).href,
  "D-02": new URL("../../contracts/fixtures/pages/D-02-page-1.png", import.meta.url).href,
  "D-03": new URL("../../contracts/fixtures/pages/D-03-page-1.png", import.meta.url).href,
  "D-11": new URL("../../contracts/fixtures/pages/D-11-page-1.png", import.meta.url).href,
  "D-12": new URL("../../contracts/fixtures/pages/D-12-page-1.png", import.meta.url).href,
  "D-13": new URL("../../contracts/fixtures/pages/D-13-page-1.png", import.meta.url).href,
};

export const caseById = new Map<string, Case>(
  fixtureCases.map(({ case: item }) => [item.caseId, item]),
);

export const documentsByCase = new Map<string, { documents: DocumentRecord[]; jobs: Job[] }>(
  fixtureCases.map(({ case: item, documents, jobs }) => [
    item.caseId,
    { documents, jobs },
  ]),
);

export const emptyIntegrity = (caseId: string): IntegrityReport => ({
  caseId,
  checkedAt: new Date().toISOString(),
  status: "PASS",
  documents: (documentsByCase.get(caseId)?.documents ?? []).map((document) => ({
    docId: document.docId,
    expectedSha256: document.sha256,
    actualSha256: document.sha256,
    status: "PASS",
  })),
});

export function caseList(): Case[] {
  return fixtureCases.map((fixture) => fixture.case);
}

export function eventsForCase(caseId: string): InvestigationEvent[] {
  return fixtureCases.find((fixture) => fixture.case.caseId === caseId)
    ?.investigationEvents ?? [];
}
