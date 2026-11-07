import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const samples = ["D-01.png", "D-02.png", "D-03.pdf"].map((name) => path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "samples", name));
const BANNED = /\b(verified|genuine|authentic|forged|forgery|fraud\w*|intentional(ly)?|deliberate(ly)?)\b/i;

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Analysed documents" })).toBeVisible();
});

test("scanner: upload the three sample documents, watch the analyzers, reach a result with the dock", async ({ page }) => {
  await page.getByRole("link", { name: "Document Scanner" }).click();
  await page.getByLabel("Choose documents").setInputFiles(samples);
  await expect(page.getByRole("list", { name: "Selected files" }).getByRole("listitem")).toHaveCount(3);
  await page.getByRole("button", { name: "Analyse 3 files" }).click();

  await expect(page.getByRole("img", { name: /Analysis progress/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Analyzer checklist" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Investigation priority: High/ })).toBeVisible({ timeout: 20_000 });
  const dock = page.getByRole("navigation", { name: "Document sections" });
  await expect(dock).toBeVisible();
  await expect(page.getByRole("link", { name: /open investigation/i })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(BANNED);
});

test("home: the analysed documents are listed and the filter and search narrow the list", async ({ page }) => {
  await expect(page.getByText("6 of 6 documents")).toBeVisible();
  await page.getByRole("button", { name: "Partial results" }).click();
  await expect(page.getByText("1 of 6 documents")).toBeVisible();
  await page.getByRole("button", { name: "All" }).click();
  await page.getByRole("searchbox", { name: "Search documents", exact: true }).fill("priya");
  await expect(page.getByText("3 of 6 documents")).toBeVisible();
  await expect(page.getByText("No anomalies observed by the analyzers that ran").first()).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(BANNED);
});

test("scanner: one failed upload does not block the others", async ({ page }) => {
  await page.goto("/scanner");
  await page.getByLabel("Choose documents").setInputFiles([
    { name: "D-01.png", mimeType: "image/png", buffer: readFileSync(samples[0]) },
    { name: "fail-evidence.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") },
  ]);
  await page.getByRole("button", { name: "Analyse 2 files" }).click();
  await expect(page.getByRole("button", { name: /fail-evidence\.pdf \(failed\)/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("navigation", { name: "Document sections" }).getByRole("link", { name: /Overview/ })).toBeVisible();
});

test("reduced motion: route content fades instead of sliding", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/scanner");
  const name = await page.locator(".route-view").evaluate((element) => getComputedStyle(element).animationName);
  expect(name).toBe("fade-only");
});
