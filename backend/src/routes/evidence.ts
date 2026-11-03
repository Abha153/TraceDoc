import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type {
  AssertionsResponse, EntitiesResponse, FindingDetail, FindingsResponse, FindingWithReview, GraphResponse,
} from "@contracts/api";
import type { DocType } from "@contracts/types";
import { AppError } from "../errors.js";
import { validate } from "../validation.js";
import { SAFE_ID_RE } from "../services/storage.js";
import type { CaseService } from "../services/cases.js";
import type { EvidenceRepository } from "../repo/evidence.js";
import type { AnalysisRepository, DocumentRepository } from "../repo/repositories.js";
import type { ReviewSource } from "../services/reviewSource.js";
import { buildGraph } from "../services/graph.js";
import type { JsonlEventLog } from "../services/eventLog.js";

const caseParams = z.object({ caseId: z.string().regex(SAFE_ID_RE, "invalid case id") });
const findingParams = z.object({ findingId: z.string().regex(SAFE_ID_RE, "invalid finding id") });
const findingsQuery = z
  .object({
    category: z.enum(["extraction", "visual", "pdf_structure", "context", "cross_document"]).optional(),
    observationStatus: z.enum(["OBSERVED", "INCONSISTENT", "POTENTIAL_ANOMALY", "INCONCLUSIVE"]).optional(),
    reviewStatus: z.enum(["UNREVIEWED", "CONFIRMED", "DISMISSED", "INCONCLUSIVE"]).optional(),
  })
  .strict();

export interface EvidenceRoutesDeps {
  cases: CaseService;
  evidence: EvidenceRepository;
  documents: DocumentRepository;
  analysis: AnalysisRepository;
  reviews: ReviewSource;
  log: JsonlEventLog;
  requireAuth: RequestHandler;
}

/**
 * Read APIs over the evidence store. A case with no reasoning run yet has no evidence, so the lists are
 * empty (never an error and never "clean": priority stays null until reasoning has run).
 */
export function evidenceRouter(d: EvidenceRoutesDeps): Router {
  const r = Router();
  const caseId = (req: { params: unknown }) => (req.params as { caseId: string }).caseId;

  r.get("/cases/:caseId/findings", d.requireAuth, validate("params", caseParams), validate("query", findingsQuery), async (req, res, next) => {
    try {
      await d.cases.require(caseId(req));
      const q = req.query as z.infer<typeof findingsQuery>;
      const record = await d.evidence.latest(caseId(req));
      const items: FindingWithReview[] = [];
      for (const finding of record?.findings ?? []) {
        if (q.category && finding.category !== q.category) continue;
        if (q.observationStatus && finding.observationStatus !== q.observationStatus) continue;
        const reviewStatus = await d.reviews.statusOf(finding.findingId);
        if (q.reviewStatus && reviewStatus !== q.reviewStatus) continue;
        items.push({ finding, reviewStatus });
      }
      const body: FindingsResponse = { caseId: caseId(req), findings: items };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  r.get("/findings/:findingId", d.requireAuth, validate("params", findingParams), async (req, res, next) => {
    try {
      const hit = await d.evidence.findFinding((req.params as { findingId: string }).findingId);
      if (!hit) throw new AppError(404, "FINDING_NOT_FOUND", "No such finding");
      await d.log.recordView(hit.finding.caseId, req.analyst!.analystId, hit.finding.findingId);
      const body: FindingDetail = {
        finding: hit.finding,
        reviewStatus: await d.reviews.statusOf(hit.finding.findingId),
        reviewHistory: await d.reviews.historyOf(hit.finding.findingId),
      };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  r.get("/cases/:caseId/assertions", d.requireAuth, validate("params", caseParams), async (req, res, next) => {
    try {
      await d.cases.require(caseId(req));
      const body: AssertionsResponse = { caseId: caseId(req), assertions: (await d.evidence.latest(caseId(req)))?.assertions ?? [] };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  r.get("/cases/:caseId/entities", d.requireAuth, validate("params", caseParams), async (req, res, next) => {
    try {
      await d.cases.require(caseId(req));
      const body: EntitiesResponse = { caseId: caseId(req), entities: (await d.evidence.latest(caseId(req)))?.entities ?? [] };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  r.get("/cases/:caseId/graph", d.requireAuth, validate("params", caseParams), async (req, res, next) => {
    try {
      await d.cases.require(caseId(req));
      const documents = await d.documents.listByCase(caseId(req));
      const record = await d.evidence.latest(caseId(req));
      const docTypes: Record<string, DocType | undefined> = {};
      const fieldNames: Record<string, string> = {};
      for (const doc of documents) {
        const analysis = await d.analysis.get(doc.docId);
        docTypes[doc.docId] = analysis?.pages[0]?.docType;
        for (const f of analysis?.fields ?? []) fieldNames[f.fieldId] = f.name;
      }
      const body: GraphResponse = buildGraph({
        caseId: caseId(req),
        documents,
        docTypes,
        fieldNames,
        assertions: record?.assertions ?? [],
        entities: record?.entities ?? [],
        findings: record?.findings ?? [],
      });
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
