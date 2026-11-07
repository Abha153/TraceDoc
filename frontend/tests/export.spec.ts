import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Analysed documents" })).toBeVisible();
});

test("home: export all findings as CSV and JSON", async ({ page }) => {
  const exportCsv = page.getByRole("button", { name: "Export CSV" });
  await expect(exportCsv).toBeEnabled();
  const [csv] = await Promise.all([page.waitForEvent("download"), exportCsv.click()]);
  expect(csv.suggestedFilename()).toMatch(/^tracedocs-findings-\d{4}-\d{2}-\d{2}\.csv$/);
  const csvText = readFileSync((await csv.path())!, "utf8");
  expect(csvText).toContain("finding_id");
  expect(csvText.trim().split(/\r?\n/).length).toBeGreaterThan(2);

  const [json] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Export JSON" }).click()]);
  const parsed = JSON.parse(readFileSync((await json.path())!, "utf8"));
  expect(parsed.mode).toBe("fixture");
  expect(parsed.documents.length).toBe(6);
  expect(parsed.findings.length).toBeGreaterThan(0);
});

test("findings tab: download this document's findings", async ({ page }) => {
  await page.goto("/documents/D-01/findings");
  const [csv] = await Promise.all([page.waitForEvent("download"), page.getByRole("group", { name: "Download this document's findings" }).getByRole("button", { name: "CSV" }).click()]);
  expect(csv.suggestedFilename()).toMatch(/^D-01-findings-/);
  expect(readFileSync((await csv.path())!, "utf8")).toContain("id_card_aarav.png");
});
