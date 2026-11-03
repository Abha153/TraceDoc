import { describe, expect, it } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";

const hash = `scrypt$${"a".repeat(32)}$${"b".repeat(128)}`;

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig({ ANALYST_PASSWORD_HASH: hash });
    expect(c.port).toBe(4000);
    expect(c.analystId).toBe("analyst");
    expect(c.cookieSecure).toBe(false);
  });
  it("makes cookies secure in production by default", () => {
    expect(loadConfig({ NODE_ENV: "production", ANALYST_PASSWORD_HASH: hash }).cookieSecure).toBe(true);
  });
  it("fails loudly without a password hash", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });
  it("rejects a plaintext password in the hash variable", () => {
    expect(() => loadConfig({ ANALYST_PASSWORD_HASH: "hunter2" })).toThrow(/hash-password/);
  });
  it("treats empty strings as unset", () => {
    expect(loadConfig({ ANALYST_PASSWORD_HASH: hash, PORT: "" }).port).toBe(4000);
  });
});

describe("retention config", () => {
  it("defaults to 90 days and rejects nonsense", async () => {
    const { loadConfig } = await import("../src/config.js");
    const base = { ANALYST_PASSWORD_HASH: "scrypt$" + "0".repeat(32) + "$" + "0".repeat(128) };
    expect(loadConfig(base).retentionDays).toBe(90);
    expect(loadConfig({ ...base, RETENTION_DAYS: "30" }).retentionDays).toBe(30);
    expect(() => loadConfig({ ...base, RETENTION_DAYS: "0" })).toThrow();
  });
});
