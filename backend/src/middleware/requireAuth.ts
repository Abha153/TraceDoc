import type { RequestHandler } from "express";
import { AppError } from "../errors.js";
import { parseCookies, SESSION_COOKIE, type SessionStore } from "../auth/sessions.js";

export function createRequireAuth(sessions: SessionStore, displayName = "Analyst"): RequestHandler {
  return (req, _res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const session = sessions.get(token);
    if (!session) {
      next(new AppError(401, "UNAUTHENTICATED", "Login required"));
      return;
    }
    req.analyst = { analystId: session.analystId, displayName };
    next();
  };
}
