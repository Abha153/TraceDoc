import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("frontend environment configuration", () => {
  it("uses documented defaults when variables are unset", async () => {
    vi.stubEnv("VITE_API_BASE", "");
    vi.stubEnv("VITE_MAX_UPLOAD_MB", "");
    vi.stubEnv("VITE_JOB_POLL_MS", "");

    const config = await import("../config");

    expect(config.apiBase).toBe("/api/v1");
    expect(config.maxUploadMegabytes).toBe(20);
    expect(config.jobPollIntervalMs).toBe(1100);
  });

  it("uses configured API, upload size, and polling interval", async () => {
    vi.stubEnv("VITE_API_BASE", "/custom-api/");
    vi.stubEnv("VITE_MAX_UPLOAD_MB", "25");
    vi.stubEnv("VITE_JOB_POLL_MS", "1000");

    const config = await import("../config");

    expect(config.apiBase).toBe("/custom-api");
    expect(config.maxUploadMegabytes).toBe(25);
    expect(config.jobPollIntervalMs).toBe(1000);
  });

  it("rejects invalid numeric settings", async () => {
    vi.stubEnv("VITE_MAX_UPLOAD_MB", "0");

    await expect(import("../config")).rejects.toThrow("VITE_MAX_UPLOAD_MB must be a positive number.");
  });
});
