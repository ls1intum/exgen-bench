import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("presents the comparison dashboard without accessibility or CSP violations", async ({
  page,
}) => {
  const policyViolations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) policyViolations.push(message.text());
  });

  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Programming exercise generation", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("Every model, cost, and result on this page is synthetic."),
  ).toBeVisible();
  await expect(page.getByTestId("value-chart")).toBeVisible();
  await expect(page.getByTestId("value-chart").getByText("$1.00")).toBeVisible();
  await expect(page.getByRole("table").first().locator("tbody tr")).toHaveCount(6);
  await expect(page.getByRole("button", { name: "Show all 12" })).toBeVisible();

  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
  expect(policyViolations).toEqual([]);
});

test("uses keyboard-accessible Base UI filters and tabs", async ({ page }) => {
  await page.goto("/");

  const directSwatch = page.locator(".approach-legend span", { hasText: "Direct" }).locator("i");
  const initialDirectColor = await directSwatch.evaluate(
    (element) => getComputedStyle(element).backgroundColor,
  );
  const approachFilter = page.getByRole("button", { name: /^Approach/ });
  await approachFilter.focus();
  await page.keyboard.press("Enter");
  const reviewed = page.getByRole("menuitemcheckbox", { name: "Plan + review" });
  await expect(reviewed).toBeVisible();
  await reviewed.focus();
  await page.keyboard.press("Space");
  await expect(reviewed).toHaveAttribute("aria-checked", "false");
  await page.keyboard.press("Escape");
  await expect(approachFilter).toBeFocused();

  await expect(page.getByText("6 of 6 shown")).toBeVisible();
  await expect(
    page.getByLabel("Benchmark results").getByText("Claude Opus 4.6 · Direct"),
  ).toBeVisible();
  await expect(directSwatch).toHaveCSS("background-color", initialDirectColor);

  const costTab = page.getByRole("tab", { name: "Cost" });
  await costTab.focus();
  await page.keyboard.press("Space");
  await expect(page.getByTestId("cost-chart")).toBeVisible();
  await expect(page).toHaveURL(/view=cost/);

  await approachFilter.focus();
  await page.keyboard.press("Enter");
  const direct = page.getByRole("menuitemcheckbox", { name: "Direct" });
  await direct.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status", { name: "" })).toContainText(
    "No configurations match these filters.",
  );
  const panelId = await costTab.getAttribute("aria-controls");
  expect(panelId).not.toBeNull();
  await expect(page.locator(`#${panelId}`)).toHaveAttribute("role", "tabpanel");
});

test("keeps quality available when secondary metrics are absent", async ({ page }) => {
  await page.route("**/release.json", async (route) => {
    const response = await route.fetch();
    const release = (await response.json()) as { systems: Array<Record<string, unknown>> };
    release.systems = release.systems.map(({ decision_metrics: _, ...system }) => system);
    await route.fulfill({ response, json: release });
  });

  await page.goto("/");
  const qualityTab = page.getByRole("tab", { name: "Quality" });
  await expect(qualityTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("quality-chart")).toBeVisible();
  await expect(page).toHaveURL(/view=quality/);

  const valueTab = page.getByRole("tab", { name: "Value" });
  await valueTab.focus();
  await page.keyboard.press("Space");
  await expect(
    page.getByRole("status").filter({
      hasText: "This release does not include precomputed cost summaries.",
    }),
  ).toBeVisible();
  await expect(page.getByRole("table").first().locator("tbody tr")).toHaveCount(6);
});

test("uses compact comparison cards without horizontal document overflow at 320 pixels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");

  await expect(page.locator(".mobile-configuration-list article")).toHaveCount(6);
  await expect(page.locator(".mobile-configuration-list").first()).toContainText("Acceptance");
  await expect(page.locator(".mobile-configuration-list").first()).toContainText("Cost");
  await expect(page.locator(".mobile-configuration-list").first()).toContainText("Latency");

  const chartTestIds = {
    Value: "value-chart",
    Quality: "quality-chart",
    Cost: "cost-chart",
    Speed: "latency-chart",
  } as const;
  for (const [view, testId] of Object.entries(chartTestIds)) {
    await page.getByRole("tab", { name: view }).click();
    const grid = await page
      .getByTestId(testId)
      .locator(".recharts-cartesian-grid")
      .boundingBox();
    expect(grid?.width).toBeGreaterThan(100);
  }

  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
});
