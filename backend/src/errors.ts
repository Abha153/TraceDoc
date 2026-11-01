import type { ErrorRequestHandler, RequestHandler } from "express";
import multer from "multer";
import type { Logger } from "./logger.js";

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, "NOT_FOUND", `No route for ${req.method} ${req.path}`));
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err, req, res, _next) => {
    if (res.headersSent) return;

    if (err instanceof AppError) {
      // contracts ErrorResponse allows only code and message; details stay in the server log
      if (err.details !== undefined) logger.debug({ code: err.code, details: err.details }, "request rejected");
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }

    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        res.status(400).json({ error: { code: "FILE_TOO_LARGE", message: "File exceeds the upload size limit" } });
      } else {
        res.status(400).json({ error: { code: "UPLOAD_ERROR", message: `Upload rejected: ${err.code}` } });
      }
      return;
    }

    // body-parser errors carry a `type` and a 4xx status
    const type = (err as { type?: string }).type;
    if (type === "entity.parse.failed") {
      res.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
      return;
    }
    if (type === "entity.too.large") {
      res.status(400).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" } });
      return;
    }

    // Unknown error: log everything, tell the client nothing internal.
    logger.error({ err, path: req.path, method: req.method }, "unhandled error");
    res.status(500).json({ error: { code: "INTERNAL", message: "Internal server error" } });
  };
}
