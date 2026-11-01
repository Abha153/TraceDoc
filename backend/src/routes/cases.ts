import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { validate } from "../validation.js";
import { SAFE_ID_RE } from "../services/storage.js";
import type { CaseService } from "../services/cases.js";

const createBody = z.object({ title: z.string().trim().min(1).max(200) }).strict();
const caseParams = z.object({ caseId: z.string().regex(SAFE_ID_RE, "invalid case id") });

export function casesRouter(cases: CaseService, requireAuth: RequestHandler): Router {
  const r = Router();

  r.post("/cases", requireAuth, validate("body", createBody), async (req, res, next) => {
    try {
      const c = await cases.create((req.body as z.infer<typeof createBody>).title, req.analyst!.analystId);
      res.status(201).json(c);
    } catch (err) {
      next(err);
    }
  });

  r.get("/cases", requireAuth, async (_req, res, next) => {
    try {
      res.json(await cases.list());
    } catch (err) {
      next(err);
    }
  });

  r.get("/cases/:caseId", requireAuth, validate("params", caseParams), async (req, res, next) => {
    try {
      const c = await cases.require((req.params as { caseId: string }).caseId);
      res.json(await cases.summary(c));
    } catch (err) {
      next(err);
    }
  });

  return r;
}
