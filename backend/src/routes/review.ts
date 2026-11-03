import { Router, type RequestHandler } from "express";
import { z } from "zod";
import type { EventsResponse } from "@contracts/api";
import { validate } from "../validation.js";
import { SAFE_ID_RE } from "../services/storage.js";
import type { ReviewService, ReclassifyService } from "../services/review.js";
import type { CaseService } from "../services/cases.js";
import type { JsonlEventLog } from "../services/eventLog.js";

const findingParams = z.object({ findingId: z.string().regex(SAFE_ID_RE, "invalid finding id") });
const caseParams = z.object({ caseId: z.string().regex(SAFE_ID_RE, "invalid case id") });
const pageParams = z.object({
  docId: z.string().regex(SAFE_ID_RE, "invalid document id"),
  n: z.string().regex(/^[1-9][0-9]{0,3}$/, "page must be a positive integer"),
});

const reviewBody = z
  .object({
    action: z.enum(["CONFIRM", "DISMISS", "INCONCLUSIVE", "COMMENT", "REOPEN"]),
    reason: z.string().max(2000).optional(),
    comment: z.string().max(4000).optional(),
  })
  .strict();

const reclassifyBody = z
  .object({
    docType: z.enum(["id_card", "application_form", "bank_statement", "other", "UNKNOWN", "AMBIGUOUS"]),
    reason: z.string().max(2000).optional(),
  })
  .strict();

export interface ReviewRoutesDeps {
  review: ReviewService;
  reclassify: ReclassifyService;
  cases: CaseService;
  log: JsonlEventLog;
  requireAuth: RequestHandler;
}

export function reviewRouter(d: ReviewRoutesDeps): Router {
  const r = Router();

  r.post("/findings/:findingId/review", d.requireAuth, validate("params", findingParams), validate("body", reviewBody), async (req, res, next) => {
    try {
      const detail = await d.review.review((req.params as { findingId: string }).findingId, req.body as z.infer<typeof reviewBody>, req.analyst!.analystId);
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  r.patch("/documents/:docId/pages/:n/type", d.requireAuth, validate("params", pageParams), validate("body", reclassifyBody), async (req, res, next) => {
    try {
      const { docId, n } = req.params as { docId: string; n: string };
      const body = req.body as z.infer<typeof reclassifyBody>;
      const job = await d.reclassify.reclassify(docId, Number(n), body.docType, body.reason, req.analyst!.analystId);
      res.status(202).json(job);
    } catch (err) {
      next(err);
    }
  });

  r.get("/cases/:caseId/events", d.requireAuth, validate("params", caseParams), async (req, res, next) => {
    try {
      const caseId = (req.params as { caseId: string }).caseId;
      await d.cases.require(caseId);
      const body: EventsResponse = { caseId, events: await d.log.forCase(caseId) };
      res.json(body);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
