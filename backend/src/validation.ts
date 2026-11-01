import type { RequestHandler } from "express";
import type { ZodTypeAny, z } from "zod";
import { AppError } from "./errors.js";

type Source = "body" | "query" | "params";

/**
 * Validates req[source] against a zod schema and replaces it with the parsed value.
 * Unknown keys are stripped only if the schema says so; use .strict() to reject them.
 */
export function validate<S extends ZodTypeAny>(source: Source, schema: S): RequestHandler {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      next(
        new AppError(
          400,
          "VALIDATION_ERROR",
          `Invalid request ${source}`,
          result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        ),
      );
      return;
    }
    (req as unknown as Record<Source, z.infer<S>>)[source] = result.data;
    next();
  };
}
