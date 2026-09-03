import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test("presents the results site without accessibility or CSP violations", async ({
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
  await expect(page.locator('meta[name="color-scheme"]')).toHaveAttribute("content", "light");
  await expect(page.locator('link[rel="icon"]')).toHaveAttribute("href", /favicon.*\.svg$/);
  await expect(
    page.getByText("Programming exercise generation benchmark", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Synthetic data—not benchmark results. Do not cite these values as findings."),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Imprint" })).toHaveAttribute(
    "href",
    "https://aet.cit.tum.de/impressum/",
  );
  await expect(page.getByRole("tab", { name: "Quality", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const qualityChart = page.getByTestId("quality-chart");
  await expect(qualityChart).toBeVisible();
  await expect(qualityChart.locator("svg.recharts-surface")).toHaveAttribute(
    "aria-labelledby",
    "quality-chart-title",
  );
  await expect(qualityChart.locator("svg.recharts-surface > title")).toBeEmpty();
  await expect(
    page
      .getByRole("figure", { name: "Exercise success rate" })
      .getByRole("paragraph")
      .filter({
        hasText:
          "Percentage of all planned attempts that produced a complete exercise, passed the independent evaluation, and stayed within budget. Intervals use illustrative case-cluster 95% interval.",
      }),
  ).toBeVisible();
  await expect(qualityChart.locator('[data-chart-mark="configuration"]')).toHaveCount(12);
  await expect(qualityChart.locator('[data-chart-mark="configuration"] image')).toHaveCount(12);
  await expect(qualityChart.locator('[data-chart-mark="configuration"] svg')).toHaveCount(12);
  await expect(qualityChart.locator(".provider-glyph-surface")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Release-level primary contrast" }),
  ).toHaveCount(0);
  await expect(page.getByText("n = 12 planned", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("n = 12 started", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("table").first().locator("tbody tr")).toHaveCount(6);
  await expect(page.getByRole("button", { name: "Show all 12" })).toBeVisible();
  expect(
    await qualityChart.evaluate((element) => element.getBoundingClientRect().top),
  ).toBeLessThanOrEqual(340);

  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
  expect(policyViolations).toEqual([]);

  await page.emulateMedia({ reducedMotion: "reduce" });
  const transitionDuration = await page
    .getByRole("tabpanel", { name: "Quality" })
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).transitionDuration));
  expect(transitionDuration).toBeLessThanOrEqual(0.001);
});

test("uses keyboard-accessible Base UI filters and tabs", async ({ page }) => {
  await page.goto("/");

  const directLegend = page.locator('.approach-legend [data-approach="Direct"]');
  await expect(directLegend).toHaveAttribute("data-symbol", "arrow-right");
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
  await expect(directLegend).toHaveAttribute("data-symbol", "arrow-right");

  const costTab = page.getByRole("tab", { name: "Cost", exact: true });
  await costTab.focus();
  await page.keyboard.press("Space");
  const costChart = page.getByTestId("cost-chart");
  await expect(costChart).toBeVisible();
  await expect(costChart.locator("svg.recharts-surface")).toHaveAttribute(
    "aria-labelledby",
    "cost-chart-title",
  );
  await expect(costChart.locator("svg.recharts-surface > title")).toBeEmpty();
  await expect(
    page
      .getByRole("figure", { name: "Cost per attempt" })
      .getByRole("paragraph")
      .filter({ hasText: "The cost axis uses a logarithmic scale." }),
  ).toBeVisible();
  await expect(page).toHaveURL(/view=cost/);

  await approachFilter.focus();
  await page.keyboard.press("Enter");
  const direct = page.getByRole("menuitemcheckbox", { name: "Direct" });
  await direct.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status", { name: "" })).toContainText(
    "No generation systems match these filters.",
  );
  const panelId = await costTab.getAttribute("aria-controls");
  expect(panelId).not.toBeNull();
  await expect(page.locator(`#${panelId}`)).toHaveAttribute("role", "tabpanel");
});

test("filters model configurations independently of provider and approach", async ({ page }) => {
  await page.goto("/");

  const modelFilter = page.getByRole("button", { name: /^Models/ });
  await modelFilter.click();
  const opus = page.getByRole("menuitemcheckbox", { name: "Claude Opus 4.6" });
  await expect(opus).toHaveAttribute("aria-checked", "true");
  await opus.click();
  await page.keyboard.press("Escape");

  await expect(page.getByTestId("quality-chart").locator('[data-chart-mark="configuration"]')).toHaveCount(
    10,
  );
  await expect(page.getByText("6 of 10 shown")).toBeVisible();
  await page.getByRole("button", { name: "Reset" }).click();
  await expect(page.getByTestId("quality-chart").locator('[data-chart-mark="configuration"]')).toHaveCount(
    12,
  );
});

test("keeps quality available when secondary metrics are absent", async ({ page }) => {
  await page.route("**/release.json", async (route) => {
    const response = await route.fetch();
    const release = (await response.json()) as {
      primary_contrast: unknown;
      systems: Array<Record<string, unknown>>;
    };
    release.systems = release.systems.map(({ decision_metrics: _, ...system }) => system);
    release.primary_contrast = null;
    await route.fulfill({ response, json: release });
  });

  await page.goto("/?view=cost");
  const qualityTab = page.getByRole("tab", { name: "Quality", exact: true });
  await expect(qualityTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("quality-chart")).toBeVisible();
  await expect(page).not.toHaveURL(/[?&]view=/);
  await expect(page.getByRole("tab", { name: "Cost–quality", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Cost", exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Speed", exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Release-level primary contrast" }),
  ).toHaveCount(0);
  await expect(page.getByRole("table").first().locator("tbody tr")).toHaveCount(6);
});

test("prioritizes the attempt funnel for a single-system release", async ({ page }) => {
  await page.route("**/release.json", async (route) => {
    const response = await route.fetch();
    const release = (await response.json()) as {
      primary_contrast: unknown;
      scope: { systems: number; planned_attempts: number };
      systems: Array<{ id: string; planned: number }>;
      cases: Array<{ systems: Record<string, unknown> }>;
      evaluations: { metrics: Array<{ system_id: string }> };
    };
    const system = release.systems[0]!;
    release.systems = [system];
    release.scope.systems = 1;
    release.scope.planned_attempts = system.planned;
    release.primary_contrast = null;
    release.cases = release.cases.map((caseItem) => ({
      ...caseItem,
      systems: { [system.id]: caseItem.systems[system.id] },
    }));
    release.evaluations.metrics = release.evaluations.metrics.filter(
      (summary) => summary.system_id === system.id,
    );
    await route.fulfill({ response, json: release });
  });

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "What happened" })).toBeVisible();
  await expect(page.getByText("Candidates produced").locator("..")).toContainText("12");
  await expect(page.getByText("Accepted by demo-oracle").locator("..")).toContainText("9");
  await expect(page.getByText("System accepted").locator("..")).toContainText("12");
  await expect(page.getByText("Budget.").locator("..")).toContainText(
    "Two planned generations per exercise brief and system",
  );
  const agreement = page.getByRole("region", { name: "Verdict agreement" });
  await expect(agreement.getByRole("row", { name: /^Accepted/ })).toContainText("9");
  await expect(
    page.getByText(
      "3 disagreements between the system's own verdict and demo-oracle on 12 candidates.",
    ),
  ).toBeVisible();
  await expect(page.getByTestId("quality-chart")).toHaveCount(0);
  await expect(
    page.getByRole("figure", { name: "Generation time per attempt" }).getByRole("paragraph"),
  ).toContainText("Recorded for 12 of 12 planned attempts.");
  await expect(page.getByTestId("effort-generation_duration_seconds")).toContainText(
    "Wall-clock minutes",
  );
  await expect(page.getByRole("tablist", { name: "Result view" })).toHaveCount(0);
  await expect(page.getByText("1 of 1 shown")).toHaveCount(0);
  await expect(page.getByTestId("effort-generation_duration_seconds")).toBeVisible();
  await expect(page.getByTestId("effort-total_tokens").locator(".effort-point")).toHaveCount(12);
  await expect(page.getByRole("tab", { name: "All evaluators" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tablist", { name: "Generation system" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Results by exercise brief" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

test("switches between catalog releases without a client-side router", async ({ page }) => {
  await page.route("**/catalog.json", async (route) => {
    const response = await route.fetch();
    const catalog = (await response.json()) as {
      releases: Array<{ id: string; label: string; manifest: string; status: string }>;
    };
    const first = catalog.releases[0]!;
    catalog.releases.push({ ...first, id: "second-release", label: "Second release" });
    await route.fulfill({ response, json: catalog });
  });

  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Release" })).toHaveValue(
    "illustrative-demo-v0.1",
  );
  await page.getByRole("combobox", { name: "Release" }).selectOption("second-release");
  await expect(page).toHaveURL(/release=second-release/);
  await expect(page.getByRole("combobox", { name: "Release" })).toHaveValue("second-release");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
});

test("shows every evaluator metric with its coverage, distribution, and per-attempt values", async ({
  page,
}) => {
  await page.goto("/");

  const evaluation = page.getByRole("region", { name: "What the evaluators measured" });
  await expect(evaluation.getByRole("paragraph").first()).toContainText(
    "5 metrics from 2 evaluators over 144 evaluated attempts.",
  );
  const systemTabs = page.getByRole("tablist", { name: "Generation system" });
  await expect(systemTabs.getByRole("tab")).toHaveCount(12);
  await expect(page.getByRole("tab", { name: "All evaluators" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const overview = page.getByRole("region", { name: "Metrics reported by every evaluator" });
  await expect(overview.locator("tbody tr")).toHaveCount(5);
  await expect(overview.locator("tbody tr").first()).toContainText("demo-oracle");
  await expect(overview.locator("tbody tr").last()).toContainText("demo-consistency");

  await page.getByRole("tab", { name: "demo-oracle authoritative" }).click();
  const metrics = page.getByRole("region", { name: "Metrics reported by demo-oracle" });
  await expect(metrics.locator("tbody tr")).toHaveCount(3);
  const coverage = metrics.locator('tr[data-metric="coverage.statement"]');
  await expect(coverage).toContainText("11 of 12");
  await expect(coverage).toContainText("1 not applicable");
  await expect(coverage.locator("svg.recharts-surface")).toHaveCount(1);
  await expect(metrics.locator('tr[data-metric="oracle.satisfied"]')).toContainText("9 of 12 true");
  await expect(metrics.getByText("Not measured")).toHaveCount(0);

  const matrix = page.getByRole("region", { name: "demo-oracle values by attempt" });
  await expect(matrix.locator("tbody tr")).toHaveCount(12);
  await expect(matrix.locator("td.score-absent", { hasText: "n/a" })).toHaveCount(1);
  await expect(matrix.locator("td.score-heat")).toHaveCount(23);
  const testsHeader = matrix.getByRole("columnheader", { name: "Declared test cases" });
  await testsHeader.getByRole("button").click();
  await expect(testsHeader).toHaveAttribute("aria-sort", "descending");
  const values = await matrix
    .locator("tbody tr td:nth-child(4)")
    .evaluateAll((cells) => cells.map((cell) => Number(cell.textContent)));
  expect(values).toEqual([...values].sort((left, right) => right - left));

  await page.getByRole("tab", { name: "demo-consistency" }).click();
  await expect(page.getByRole("region", { name: "Metrics reported by demo-consistency" })).toBeVisible();
  await systemTabs.getByRole("tab", { name: "Gemini 3.5 Flash · Direct" }).click();
  await expect(
    page.getByText("demo-consistency@0.1 · illustrative · 12 of 12 attempts evaluated"),
  ).toBeVisible();

  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test("discloses partial secondary-metric coverage", async ({ page }) => {
  await page.route("**/release.json", async (route) => {
    const response = await route.fetch();
    const release = (await response.json()) as {
      systems: Array<{
        decision_metrics?: {
          cost?: unknown;
          latency?: unknown;
        };
      }>;
    };
    release.systems.forEach((system, index) => {
      if (index % 2 === 0 && system.decision_metrics) {
        delete system.decision_metrics.cost;
      }
    });
    await route.fulfill({ response, json: release });
  });

  await page.goto("/?view=cost");
  const costChart = page.getByTestId("cost-chart");
  await expect(costChart.locator('[data-chart-mark="configuration"]')).toHaveCount(6);
  await expect(
    page
      .getByRole("figure", { name: "Cost per attempt" })
      .getByRole("paragraph")
      .filter({
        hasText: "Shown for 6 of 12 generation systems with a published cost summary.",
      }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Cost–quality", exact: true }).click();
  const valueChart = page.getByTestId("value-chart");
  await expect(valueChart.locator('[data-chart-mark="configuration"]')).toHaveCount(6);
  await expect(
    page
      .getByRole("figure", { name: "Cost–quality" })
      .getByRole("paragraph")
      .filter({
        hasText: "Shown for 6 of 12 generation systems with a published cost summary.",
      }),
  ).toBeVisible();

  await page.getByRole("tab", { name: "Speed", exact: true }).click();
  await expect(
    page.getByTestId("latency-chart").locator('[data-chart-mark="configuration"]'),
  ).toHaveCount(12);
});

test("uses accessible animated disclosures for release detail", async ({ page }) => {
  await page.goto("/");

  const method = page.getByRole("button", { name: "Method and limitations" });
  const briefs = page.getByRole("button", { name: "Results by exercise brief" });
  await expect(method).toHaveAttribute("aria-expanded", "false");
  await method.click();
  await expect(method).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByText(
      "Not benchmark results. Do not cite, compare, or reuse these synthetic estimates as empirical findings.",
    ),
  ).toBeVisible();

  await briefs.click();
  await expect(briefs).toHaveAttribute("aria-expanded", "true");
  await expect(method).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("table").nth(1)).toBeVisible();

  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(scan.violations).toEqual([]);
});

test("uses compact configuration summaries without horizontal document overflow at 320 pixels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");

  await expect(page.locator(".mobile-configuration-list article")).toHaveCount(6);
  await expect(page.locator(".mobile-configuration-list").first()).toContainText(
    "Exercise success rate",
  );
  await expect(page.locator(".mobile-configuration-list").first()).toContainText("Cost");
  await expect(page.locator(".mobile-configuration-list").first()).toContainText(
    "Generation time",
  );

  const chartTestIds = {
    Quality: "quality-chart",
    "Cost–quality": "value-chart",
    Cost: "cost-chart",
    Speed: "latency-chart",
  } as const;
  for (const [view, testId] of Object.entries(chartTestIds)) {
    await page.getByRole("tab", { name: view, exact: true }).click();
    const chart = page.getByTestId(testId);
    const grid = await chart.locator(".recharts-cartesian-grid").boundingBox();
    expect(grid?.width).toBeGreaterThan(100);
    await expect(chart.locator('[data-chart-mark="configuration"]')).toHaveCount(12);
    await expect(chart.locator('[data-chart-mark="configuration"] image')).toHaveCount(12);
    await expect(chart.locator('[data-chart-mark="configuration"] svg')).toHaveCount(12);

    const scan = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(scan.violations).toEqual([]);
  }

  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
});
