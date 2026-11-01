import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";
import type { Logger } from "../logger.js";

export function createRequestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    req.requestId = randomUUID();
    res.setHeader("x-request-id", req.requestId);
    res.on("finish", () => {
      logger.info(
        {
          requestId: req.requestId,
          method: req.method,
          path: req.path,
          status: res.statusCode,
          ms: Number(process.hrtime.bigint() - start) / 1e6,
        },
        "request",
      );
    });
    next();
  };
}
