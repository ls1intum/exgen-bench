import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("shows the release results and passes automated WCAG checks", async ({ page }) => {
  const policyViolations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) policyViolations.push(message.text());
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Illustrative exercise-generation study" }),
  ).toBeVisible();
  await expect(page.getByText("This page does not contain benchmark results.")).toBeVisible();
  await expect(page.locator(".result-row")).toHaveCount(2);
  await expect(page.getByRole("table")).toContainText("Bounded counter");

  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
  expect(policyViolations).toEqual([]);
});

test("filters briefs and system dimensions", async ({ page }) => {
  await page.goto("/");

  await page.getByLabel("Filter briefs").fill("reservation");
  await expect(page.locator("#case-table-body tr")).toHaveCount(1);
  await expect(page.getByRole("table")).toContainText("Reservation ledger");
  await page.getByLabel("Filter briefs").clear();

  await page.getByLabel("Approach").selectOption("staged");
  await expect(page.locator(".result-row")).toHaveCount(1);
  await expect(page.locator(".result-row")).toContainText("Orchard");
  await expect(page.locator("#case-table-head th")).toHaveCount(2);
  await expect(page).toHaveURL(/approach=staged/);
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
