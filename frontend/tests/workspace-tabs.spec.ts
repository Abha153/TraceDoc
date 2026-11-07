import { expect, test } from "@playwright/test";

const BANNED = /\b(verified|genuine|authentic|forged|forgery|fraud\w*|intentional(ly)?|deliberate(ly)?)\b/i;

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Analysed documents" })).toBeVisible();
});

test("findings: review waits for the server, keeps the machine status and asks for a dismissal reason", async ({ page }) => {
  await page.goto("/documents/D-01/findings");
  const review = page.getByRole("region", { name: "Analyst review" });
  await review.getByRole("button", { name: /dismiss with reason/i }).click();
  await expect(review.getByRole("alert")).toContainText("Add a reason before dismissing");
  await review.getByRole("button", { name: /confirm observation/i }).click();
  await expect(review.getByText("CONFIRMED", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Finding detail" }).getByText("Machine observation")).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(BANNED);
});

test("evidence: show on page highlights a region and the header and dock stay mounted", async ({ page }) => {
  await page.goto("/documents/D-01/evidence");
  await page.getByRole("button", { name: /Show on page:/ }).first().click();
  await expect(page.locator(".region-active").first()).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Document sections" })).toBeVisible();
});

test("evidence: reclassify a page and watch the re-run job", async ({ page }) => {
  await page.goto("/documents/D-01/evidence");
  const pages = page.getByRole("region", { name: "Pages and document type" });
  await pages.getByLabel("Document type for page 1").selectOption("bank_statement");
  await pages.getByRole("button", { name: "Reclassify" }).click();
  await expect(page.getByRole("status", { name: "Re-run job" })).toBeVisible();
  await expect(page.getByText(/corrected by/)).toBeVisible({ timeout: 20_000 });
});

test("report: every section is present, export is offered and no verdict wording appears", async ({ page }) => {
  await page.goto("/documents/D-01/report");
  for (const name of ["Executive summary", "Technical analysis", "Observed versus potential", "Limitations and analyzer failures", "Review outcomes and history", "Integrity", "Event timeline"]) {
    await expect(page.getByRole("region", { name })).toBeVisible();
  }
  await expect(page.getByRole("button", { name: /export pdf/i })).toBeVisible();
  expect(await page.locator("body").innerText()).not.toMatch(BANNED);
});
