import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../errors.js";
import { validate } from "../validation.js";
import { SAFE_ID_RE } from "../services/storage.js";
import type { JobService } from "../services/jobs.js";

const params = z.object({ jobId: z.string().regex(SAFE_ID_RE, "invalid job id") });

export function jobsRouter(jobs: JobService, requireAuth: RequestHandler): Router {
  const r = Router();
  r.get("/jobs/:jobId", requireAuth, validate("params", params), async (req, res, next) => {
    try {
      const job = await jobs.get((req.params as { jobId: string }).jobId);
      if (!job) throw new AppError(404, "JOB_NOT_FOUND", "No such job");
      res.json(job);
    } catch (err) {
      next(err);
    }
  });
  return r;
}
