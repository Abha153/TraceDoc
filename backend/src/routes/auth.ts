import { Router, type RequestHandler } from "express";
import { z } from "zod";
import { AppError } from "../errors.js";
import { validate } from "../validation.js";
import { verifyPassword } from "../auth/password.js";
import {
  parseCookies,
  SESSION_COOKIE,
  type LoginLimiter,
  type SessionStore,
} from "../auth/sessions.js";
import type { AppConfig } from "../config.js";

const loginBody = z
  .object({ username: z.string().min(1).max(200), password: z.string().min(1).max(1000) })
  .strict();

export interface AuthDeps {
  config: AppConfig;
  sessions: SessionStore;
  limiter: LoginLimiter;
  requireAuth: RequestHandler;
}

export function authRouter({ config, sessions, limiter, requireAuth }: AuthDeps): Router {
  const r = Router();
  const cookieOpts = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.cookieSecure,
    path: "/",
  };

  r.post("/auth/login", validate("body", loginBody), async (req, res, next) => {
    try {
      const key = req.ip ?? "unknown";
      if (limiter.isBlocked(key)) {
        throw new AppError(429, "TOO_MANY_ATTEMPTS", "Too many failed logins, try again later");
      }
      const { username, password } = req.body as z.infer<typeof loginBody>;
      // Always verify the password so timing does not reveal whether the username exists.
      const passwordOk = await verifyPassword(password, config.analystPasswordHash);
      if (!passwordOk || username !== config.analystId) {
        limiter.recordFailure(key);
        throw new AppError(401, "INVALID_CREDENTIALS", "Invalid username or password");
      }
      limiter.reset(key);
      const token = sessions.create(config.analystId);
      res.cookie(SESSION_COOKIE, token, { ...cookieOpts, maxAge: config.sessionTtlMs });
      res.json({ analyst: { id: config.analystId } });
    } catch (err) {
      next(err);
    }
  });

  r.post("/auth/logout", (req, res) => {
    sessions.destroy(parseCookies(req.headers.cookie)[SESSION_COOKIE]);
    res.clearCookie(SESSION_COOKIE, cookieOpts);
    res.json({ ok: true });
  });

  r.get("/auth/me", requireAuth, (req, res) => {
    res.json({ analyst: req.analyst });
  });

  return r;
}
