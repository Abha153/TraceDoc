import { expect, test, type Page } from "@playwright/test";

const ROUTES = ["/cases", "/upload", "/findings", "/entities", "/reports"];

test.beforeEach(async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Cases" })).toBeVisible();
});

async function unnamedControls(page: Page) {
  return page.evaluate(() => {
    const visible = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const nameOf = (el: Element): string => {
      const labelledby = el.getAttribute("aria-labelledby");
      const byId = labelledby ? labelledby.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
      const id = el.getAttribute("id");
      const label = id ? document.querySelector(`label[for="${id}"]`)?.textContent ?? "" : "";
      const wrapped = el.closest("label")?.textContent ?? "";
      const img = el.querySelector("img[alt]")?.getAttribute("alt") ?? "";
      return (el.getAttribute("aria-label") || byId || label || wrapped || (el as HTMLElement).innerText || el.getAttribute("title") || el.getAttribute("placeholder") || img || "").trim();
    };
    return Array.from(document.querySelectorAll("button, a[href], input:not([type=hidden]), select, textarea, [role=button]"))
      .filter(visible).filter((el) => !nameOf(el)).map((el) => el.outerHTML.slice(0, 120));
  });
}

test("golden path by keyboard-reachable controls: case, finding, show in document, review", async ({ page }) => {
  await page.getByRole("link", { name: /CASE-001/ }).first().click();
  await page.getByRole("link", { name: "Review findings" }).click();
  await page.getByRole("link", { name: /DOB CONFLICT/ }).click();
  await page.getByRole("button", { name: /show in document: dob.*D-01/i }).first().click();
  await expect(page.locator(".region-active").first()).toBeVisible();
  await expect(page.getByText("200%")).toBeVisible();

  // review: a dismissal without a reason is refused, with a reason it is recorded and the machine status stays
  await page.getByRole("button", { name: /dismiss/i }).first().click();
  const machine = await page.getByText("INCONSISTENT").first().textContent();
  expect(machine).toBeTruthy();
  const confirm = page.getByRole("button", { name: /confirm observation/i });
  await confirm.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText("CONFIRMED").first()).toBeVisible();
  await expect(page.getByText("INCONSISTENT").first()).toBeVisible();
});

test("viewer is operable by keyboard and shows a value-and-confidence tooltip on hover and focus", async ({ page }) => {
  await page.goto("/documents/D-02");
  const regions = page.locator("rect.region-box");
  await expect(regions.first()).toBeVisible();
  await regions.first().hover({ force: true });
  const tip = page.getByRole("tooltip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(/% confidence/);
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();

  await regions.nth(1).focus();
  await expect(page.getByRole("tooltip")).toBeVisible();

  const page_ = page.getByLabel(/Document page\./);
  await page_.focus();
  await expect(page.getByText("100%")).toBeVisible();
  await page.keyboard.press("+");
  await expect(page.getByText("115%")).toBeVisible();
  await page.keyboard.press("-");
  await expect(page.getByText("100%")).toBeVisible();
});

test("case list can be sorted and says which way", async ({ page }) => {
  await page.getByLabel("Sort by").selectOption("title");
  await expect(page.getByRole("button", { name: /sorted ascending/i })).toBeEnabled();
  const titles = async () => (await page.locator(".case-card h2").allTextContents()).map((t) => t.toLowerCase());
  const asc = await titles();
  expect(asc).toEqual([...asc].sort());
  await page.getByRole("button", { name: /sorted ascending/i }).click();
  expect(await titles()).toEqual([...asc].reverse());
});

for (const [width, height] of [[1366, 768], [1280, 720]] as const) {
  test(`every main view fits a laptop screen without sideways scrolling (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    for (const route of ROUTES) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      const w = await page.evaluate(() => document.documentElement.scrollWidth);
      expect(w, `${route} at ${width}px`).toBeLessThanOrEqual(width);
    }
  });
}

test("every control on the main views has an accessible name", async ({ page }) => {
  for (const route of ROUTES) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    expect(await unnamedControls(page), route).toEqual([]);
  }
  await page.goto("/documents/D-02");
  await expect(page.locator("rect.region-box").first()).toBeVisible();
  expect(await unnamedControls(page), "document viewer").toEqual([]);
});

test("no view claims certainty or intent", async ({ page }) => {
  const banned = /\b(fraud\w*|forged|forgery|proves?|proof of|deliberate(ly)?|intentional(ly)?)\b/i;
  for (const route of [...ROUTES, "/documents/D-02", "/cases/CASE-001", "/compare/F-0001"]) {
    await page.goto(route);
    await page.waitForLoadState("networkidle");
    const text = await page.locator("body").innerText();
    // the page that explains that priority is NOT a fraud probability may name the word to negate it
    const offending = text.split("\n").filter((l) => banned.test(l) && !/\bnot a (fraud )?(probability|verdict)|not a probability/i.test(l));
    expect(offending, route).toEqual([]);
  }
});
