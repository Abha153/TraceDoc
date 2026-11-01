import { Router, type RequestHandler } from "express";
import multer from "multer";
import { z } from "zod";
import type { DocumentDetail } from "@contracts/api";
import { AppError } from "../errors.js";
import { validate } from "../validation.js";
import { SAFE_ID_RE } from "../services/storage.js";
import type { CaseService } from "../services/cases.js";
import type { UploadService } from "../services/upload.js";
import type { AnalysisRepository, DocumentRepository } from "../repo/repositories.js";

const MAX_FILES_PER_REQUEST = 20;

const caseParams = z.object({ caseId: z.string().regex(SAFE_ID_RE, "invalid case id") });
const docParams = z.object({ docId: z.string().regex(SAFE_ID_RE, "invalid document id") });

export interface DocumentsDeps {
  upload: UploadService;
  cases: CaseService;
  documents: DocumentRepository;
  analysis: AnalysisRepository;
  requireAuth: RequestHandler;
  maxUploadBytes: number;
}

export function documentsRouter(d: DocumentsDeps): Router {
  const r = Router();
  const multipart = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: d.maxUploadBytes, files: MAX_FILES_PER_REQUEST, fields: 5 },
    defParamCharset: "utf8",
  }).array("files", MAX_FILES_PER_REQUEST);

  // Order matters: auth, then case check, then multer, so nothing is buffered for a missing case.
  const requireCase: RequestHandler = async (req, _res, next) => {
    try {
      await d.cases.require((req.params as { caseId: string }).caseId);
      next();
    } catch (err) {
      next(err);
    }
  };

  r.post(
    "/cases/:caseId/documents",
    d.requireAuth,
    validate("params", caseParams),
    requireCase,
    multipart,
    async (req, res, next) => {
      try {
        const files = (req.files as Express.Multer.File[] | undefined) ?? [];
        const result = await d.upload.upload(
          (req.params as { caseId: string }).caseId,
          files.map((f) => ({ originalname: f.originalname, buffer: f.buffer })),
        );
        res.status(202).json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  r.get("/documents/:docId", d.requireAuth, validate("params", docParams), async (req, res, next) => {
    try {
      const docId = (req.params as { docId: string }).docId;
      const document = await d.documents.get(docId);
      if (!document) throw new AppError(404, "DOCUMENT_NOT_FOUND", "No such document");
      const analysis = await d.analysis.get(docId);
      const detail: DocumentDetail = { document, pages: analysis?.pages ?? [], fields: analysis?.fields ?? [] };
      res.json(detail);
    } catch (err) {
      next(err);
    }
  });

  return r;
}
