import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { validate } from "../validation.js";
import { SAFE_ID_RE } from "../services/storage.js";
import type { CaseService } from "../services/cases.js";
import type { IntegrityService } from "../services/integrity.js";

const params = z.object({ caseId: z.string().regex(SAFE_ID_RE, "invalid case id") });

/** GET /cases/:caseId/integrity: recompute the SHA-256 of every original and compare with the manifest. */
export function integrityRouter(d: { cases: CaseService; integrity: IntegrityService; requireAuth: RequestHandler }): Router {
  const r = Router();
  r.get("/cases/:caseId/integrity", d.requireAuth, validate("params", params), async (req, res, next) => {
    try {
      const caseId = (req.params as { caseId: string }).caseId;
      await d.cases.require(caseId);
      res.json(await d.integrity.check(caseId));
    } catch (err) {
      next(err);
    }
  });
  return r;
}
