import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Analysed documents" })).toBeVisible();
});

test("opens a case, focuses finding evidence, and records analyst review", async ({ page }) => {
  await page.getByRole("link", { name: /^Cases$/ }).click();
  await page.getByRole("link", { name: /CASE-001/ }).first().click();
  await expect(page).toHaveURL(/\/cases\/CASE-001$/);
  await page.getByRole("link", { name: "Review findings" }).click();
  await page.getByRole("link", { name: /DOB CONFLICT/ }).click();

  const region = page.getByRole("button", { name: /DOB CONFLICT:/ });
  await expect(region).toBeVisible();
  await expect(region).toHaveClass(/region-active/);
  await page.getByRole("button", { name: /dob.*D-01.*page 1/i }).click();
  await expect(region).toHaveClass(/region-active/);
  await page.getByRole("button", { name: /confirm observation/i }).click();
  await expect(page.getByText("CONFIRMED").first()).toBeVisible();
  await expect(page.getByText("INCONSISTENT").first()).toBeVisible();
});

test("renders Cytoscape and opens an assertion-linked document region", async ({ page }) => {
  await page.getByRole("link", { name: "Entities" }).click();
  await expect(page.getByRole("heading", { name: "Entities & assertions" })).toBeVisible();
  await expect(page.locator(".cytoscape-graph canvas").first()).toBeVisible();
  await page.getByRole("button", { name: /document: D-01 id_card/i }).click();

  await expect(page).toHaveURL(/\/documents\/D-01$/);
  await expect(page.locator(".region-active").first()).toBeVisible();
});

test("keeps the workspace usable on narrow screens with keyboard-operable navigation", async ({ page }) => {
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(documentWidth, `horizontal overflow at ${width}px`).toBeLessThanOrEqual(width);
  }

  await page.setViewportSize({ width: 390, height: 844 });
  const menuButton = page.getByRole("button", { name: "Open navigation" });
  await menuButton.click();
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
});
