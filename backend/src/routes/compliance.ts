import { Router, type RequestHandler } from "express";
import type { RetentionPolicy } from "@contracts/api";

/** Serves the configured retention policy. It is configuration only: no purge job exists, and the response says so. */
export function complianceRouter(requireAuth: RequestHandler, retentionDays: number): Router {
  const r = Router();
  r.get("/compliance/retention-policy", requireAuth, (_req, res) => {
    const body: RetentionPolicy = {
      rawEvidenceRetentionDays: retentionDays,
      purgeImplemented: false,
      note: "Configured policy only. Automatic purging is not implemented; stored evidence is kept until removed manually.",
    };
    res.json(body);
  });
  return r;
}
