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
