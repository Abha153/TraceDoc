import { Router, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import { validate } from "../validation.js";
import type { IngestService } from "../services/ingest.js";

const MAX_FILES_PER_REQUEST = 20;

const caseParams = z.object({ caseId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/, "invalid case id") });

export interface DocumentsDeps {
  ingest: IngestService;
  requireAuth: RequestHandler;
  maxUploadBytes: number;
}

export function documentsRouter({ ingest, requireAuth, maxUploadBytes }: DocumentsDeps): Router {
  const r = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxUploadBytes, files: MAX_FILES_PER_REQUEST, fields: 5 },
    defParamCharset: "utf8",
  }).array("files", MAX_FILES_PER_REQUEST);

  // Auth first, so unauthenticated clients cannot make the server buffer uploads.
  r.post("/cases/:caseId/documents", requireAuth, validate("params", caseParams), upload, async (req, res, next) => {
    try {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const docs = await ingest.ingest(
        (req.params as { caseId: string }).caseId,
        files.map((f) => ({ originalname: f.originalname, buffer: f.buffer })),
      );
      res.status(201).json({ docIds: docs.map((d) => d.docId), documents: docs });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
