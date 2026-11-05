import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    // Optional: run against a Chromium you already have (set PLAYWRIGHT_CHROMIUM_PATH), e.g. where
    // `npx playwright install` cannot download browsers. Unset = Playwright's own browser.
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] }
      : {},
  },
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    env: { VITE_USE_MOCKS: "true" },
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
