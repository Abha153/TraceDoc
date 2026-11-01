import { describe, expect, it } from "vitest";
import request from "supertest";
import { testApp, TEST_PASSWORD, TEST_USER } from "./helpers.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { LoginLimiter, SessionStore, parseCookies } from "../src/auth/sessions.js";

const login = (app: Parameters<typeof request>[0], password = TEST_PASSWORD, username = TEST_USER) =>
  request(app).post("/api/v1/auth/login").send({ username, password });

describe("health", () => {
  it("is public and returns ok", async () => {
    const { app } = await testApp();
    const res = await request(app).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
  });
});

describe("login / me / logout", () => {
  it("logs in with correct credentials and sets an HttpOnly cookie", async () => {
    const { app } = await testApp();
    const res = await login(app);
    expect(res.status).toBe(200);
    expect(res.body.analyst.id).toBe(TEST_USER);
    const cookie = (res.headers["set-cookie"] as unknown as string[])[0]!;
    expect(cookie).toMatch(/td_session=/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  it("rejects a wrong password and a wrong username with the same generic error", async () => {
    const { app } = await testApp();
    const a = await login(app, "nope");
    const b = await login(app, TEST_PASSWORD, "someone-else");
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.code).toBe("INVALID_CREDENTIALS");
    expect(b.body).toEqual(a.body);
    expect(a.headers["set-cookie"]).toBeUndefined();
  });

  it("/auth/me needs a session and returns the analyst with one", async () => {
    const { app } = await testApp();
    expect((await request(app).get("/api/v1/auth/me")).status).toBe(401);
    const agent = request.agent(app);
    await agent.post("/api/v1/auth/login").send({ username: TEST_USER, password: TEST_PASSWORD });
    const me = await agent.get("/api/v1/auth/me");
    expect(me.status).toBe(200);
    expect(me.body.analyst.id).toBe(TEST_USER);
  });

  it("logout invalidates the session server-side", async () => {
    const { app } = await testApp();
    const agent = request.agent(app);
    const l = await agent.post("/api/v1/auth/login").send({ username: TEST_USER, password: TEST_PASSWORD });
    const stolen = (l.headers["set-cookie"] as unknown as string[])[0]!.split(";")[0]!;
    await agent.post("/api/v1/auth/logout");
    const replay = await request(app).get("/api/v1/auth/me").set("Cookie", stolen);
    expect(replay.status).toBe(401);
  });

  it("blocks after repeated failures, even with the right password", async () => {
    const { app } = await testApp();
    for (let i = 0; i < 5; i++) await login(app, "bad");
    const res = await login(app);
    expect(res.status).toBe(429);
  });
});

describe("validation and errors", () => {
  it("returns 400 with issue paths for a malformed login body", async () => {
    const { app } = await testApp();
    const res = await request(app).post("/api/v1/auth/login").send({ username: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.details[0].path).toBe("password");
  });

  it("rejects unknown body keys", async () => {
    const { app } = await testApp();
    const res = await request(app)
      .post("/api/v1/auth/login")
      .send({ username: TEST_USER, password: TEST_PASSWORD, admin: true });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const { app } = await testApp();
    const res = await request(app)
      .post("/api/v1/auth/login")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_JSON");
  });

  it("returns a JSON 404 for unknown routes", async () => {
    const { app } = await testApp();
    const res = await request(app).get("/api/v1/nothing-here");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("hides internals on unexpected errors", async () => {
    const { app, deps } = await testApp();
    // Hostile verifier input: a stored hash that makes scrypt throw is handled, so force a throw via sessions.
    deps.sessions.create = () => {
      throw new Error("secret internal detail /etc/passwd");
    };
    const res = await request(app).post("/api/v1/auth/login").send({ username: TEST_USER, password: TEST_PASSWORD });
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/passwd|internal detail/);
    expect(res.body.error.code).toBe("INTERNAL");
  });
});

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", async () => {
    const h = await hashPassword("abc");
    expect(await verifyPassword("abc", h)).toBe(true);
    expect(await verifyPassword("abd", h)).toBe(false);
  });
  it("uses a fresh salt each time", async () => {
    expect(await hashPassword("abc")).not.toBe(await hashPassword("abc"));
  });
  it("returns false for malformed stored hashes", async () => {
    expect(await verifyPassword("abc", "plaintext")).toBe(false);
    expect(await verifyPassword("abc", "scrypt$zz$zz")).toBe(false);
  });
});

describe("session store and limiter", () => {
  it("expires sessions after the TTL", () => {
    let t = 1000;
    const s = new SessionStore(500, () => t);
    const tok = s.create("a");
    expect(s.get(tok)?.analystId).toBe("a");
    t += 501;
    expect(s.get(tok)).toBeUndefined();
  });
  it("limiter window slides", () => {
    let t = 0;
    const l = new LoginLimiter(2, 100, () => t);
    l.recordFailure("ip");
    l.recordFailure("ip");
    expect(l.isBlocked("ip")).toBe(true);
    t = 101;
    expect(l.isBlocked("ip")).toBe(false);
  });
  it("parses cookies", () => {
    expect(parseCookies("a=1; b=two%20words")).toEqual({ a: "1", b: "two words" });
  });
});
