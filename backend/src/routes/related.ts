import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { RelatedCasesResponse } from "@contracts/api";
import { CORRELATION_BASIS, correlateCases, type CorrelationCase } from "../engine/correlation.js";
import { validate } from "../validation.js";
import { SAFE_ID_RE } from "../services/storage.js";
import type { CaseService } from "../services/cases.js";
import type { CaseRepository, DocumentRepository } from "../repo/repositories.js";
import type { EvidenceRepository } from "../repo/evidence.js";

const caseParams = z.object({ caseId: z.string().regex(SAFE_ID_RE, "invalid case id") });

export interface RelatedDeps {
  cases: CaseService;
  caseRepo: CaseRepository;
  documents: DocumentRepository;
  evidence: EvidenceRepository;
  requireAuth: RequestHandler;
}

/** GET /cases/:caseId/related: strong identifiers and identical files that also appear in other cases (a lead, never a finding). */
export function relatedRouter(d: RelatedDeps): Router {
  const r = Router();

  const load = async (caseId: string, title: string): Promise<CorrelationCase> => ({
    caseId,
    title,
    assertions: (await d.evidence.latest(caseId))?.assertions ?? [],
    documents: (await d.documents.listByCase(caseId)).map((doc) => ({ docId: doc.docId, sha256: doc.sha256 })),
  });

  r.get("/cases/:caseId/related", d.requireAuth, validate("params", caseParams), async (req, res, next) => {
    try {
      const caseId = (req.params as { caseId: string }).caseId;
      const current = await d.cases.require(caseId);
      const all = await d.caseRepo.list();
      const mine = await load(current.caseId, current.title);
      const others = await Promise.all(all.filter((c) => c.caseId !== caseId).map((c) => load(c.caseId, c.title)));
      const body: RelatedCasesResponse = { caseId, related: correlateCases(mine, others), basis: CORRELATION_BASIS };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
