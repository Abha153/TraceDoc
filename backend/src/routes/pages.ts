import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../errors.js";
import { validate } from "../validation.js";
import { SAFE_ID_RE, type Storage } from "../services/storage.js";
import type { AnalysisRepository, DocumentRepository } from "../repo/repositories.js";

const params = z.object({
  docId: z.string().regex(SAFE_ID_RE, "invalid document id"),
  n: z.string().regex(/^[1-9][0-9]{0,3}$/, "page must be a positive integer"),
});

export interface PagesDeps {
  storage: Storage;
  documents: DocumentRepository;
  analysis: AnalysisRepository;
  requireAuth: RequestHandler;
}

/**
 * Serves the canonical render of a page (all region boxes use this image's coordinate space).
 * The file path is built from the validated docId and page number only. The renderPath reported by the
 * analysis service is never used to open a file, so a bad service response cannot point this route elsewhere.
 * Renders live at DATA_DIR/derived/<docId>/page-<n>.png, which is what renderPath is meant to name.
 */
export function pagesRouter(d: PagesDeps): Router {
  const r = Router();
  r.get("/documents/:docId/pages/:n/render", d.requireAuth, validate("params", params), async (req, res, next) => {
    try {
      const { docId, n } = req.params as { docId: string; n: string };
      if (!(await d.documents.get(docId))) throw new AppError(404, "DOCUMENT_NOT_FOUND", "No such document");
      const analysis = await d.analysis.get(docId);
      if (!analysis?.pages.some((p) => p.page === Number(n))) throw new AppError(404, "PAGE_NOT_FOUND", "No such page");
      const file = d.storage.derivedFile(docId, `page-${n}.png`);
      // Headers go in the sendFile options so they are only sent with a real image, never with an error body.
      res.sendFile(file, { dotfiles: "deny", headers: { "Cache-Control": "private, max-age=3600" } }, (err) => {
        if (err) next(new AppError(404, "RENDER_NOT_FOUND", "The page render is not available"));
      });
    } catch (err) {
      next(err);
    }
  });
  return r;
}
