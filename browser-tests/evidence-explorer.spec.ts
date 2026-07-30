import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("loads the versioned release and passes automated WCAG checks", async ({ page }) => {
  const policyViolations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) policyViolations.push(message.text());
  });
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Results you can inspect/ })).toBeVisible();
  await expect(page.getByText("Illustrative demo")).toBeVisible();
  await expect(page.locator(".system-card")).toHaveCount(2);
  const zeroBar = page
    .locator("#final-dispositions .funnel-row")
    .filter({ hasText: "Generation failed" })
    .locator(".funnel-fill");
  expect(await zeroBar.evaluate((element) => element.getBoundingClientRect().width)).toBe(0);

  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
  expect(policyViolations).toEqual([]);
});

test("filters cases by text and handles empty outcome categories", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator(".case-row");
  await expect(rows).toHaveCount(6);

  await page.getByLabel("Search cases").fill("reservation");
  await expect(page.locator("#case-count")).toContainText("1 of 6");
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText("Reservation ledger");
  await page.getByLabel("Search cases").clear();

  await page.getByLabel("Outcome").selectOption("mixed");
  await expect(page.locator("#case-count")).toContainText("6 of 6");
  await expect(rows).toHaveCount(6);

  await page.getByLabel("Outcome").selectOption("accepted");
  await expect(page.locator("#case-count")).toContainText("0 of 6");
  await expect(rows).toHaveCount(0);

  await page.getByLabel("Outcome").selectOption("no-acceptance");
  await expect(page.locator("#case-count")).toContainText("0 of 6");
  await expect(rows).toHaveCount(0);
});

test("dialog is keyboard-operable, accessible, and returns focus", async ({ page }) => {
  await page.goto("/");
  const opener = page.getByRole("button", { name: "Inspect evidence" }).first();
  await opener.focus();
  await opener.press("Enter");

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("heading", { name: "Bounded counter" })).toBeFocused();
  await expect(page.getByRole("button", { name: "Close case details" })).toBeVisible();
  const scan = await new AxeBuilder({ page }).include("#case-dialog").analyze();
  expect(scan.violations).toEqual([]);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("reflows without horizontal document overflow at 320 CSS pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");
  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
});
