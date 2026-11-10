import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * The study team's preview of a built study before deployment, `exgen survey preview`, on the
 * survey server's fixture study. The deployed preview behind the study team's link is the same page;
 * survey.spec.ts opens it from the dashboard.
 */

const PREVIEW = "http://127.0.0.1:4192";

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes })),
  ).toEqual([]);
}

test("the study team reviews every frozen exercise as raters see it, without a session", async ({
  page,
}) => {
  const policyViolations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) policyViolations.push(message.text());
  });
  await page.goto(`${PREVIEW}/preview`);
  await expect(page).toHaveURL(`${PREVIEW}/preview/E1`);
  await expect(page.getByRole("note")).toContainText(
    "Preview — not a rater session; nothing is recorded",
  );
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("E1 · Step Statistics");
  await expect(main.getByText("step-statistics", { exact: true })).toBeVisible();
  for (const part of ["Part A", "Part B", "Part C", "Part D"]) {
    await expect(
      main.getByRole("heading", { level: 2, name: new RegExp(`^${part} · `) }),
    ).toBeVisible();
  }
  for (const material of [
    "Problem statement",
    "Brief",
    "Template",
    "Solution changes",
    "Tests",
    "Findings",
  ]) {
    await expect(
      // The findings report repeats its own heading inside the section.
      main.getByRole("heading", { level: 3, name: material, exact: true }).first(),
    ).toBeVisible();
  }
  // The generator's identity stays in the manifest.
  await expect(page.locator("body")).not.toContainText("demo-generator");
  await expect(page.getByRole("link", { name: "Back to the dashboard" })).toHaveCount(0);
  await expectAccessible(page);

  // The keyboard moves between exercises; the new exercise's heading takes the focus.
  const exercises = page.getByRole("navigation", { name: "Exercises" });
  await expect(exercises.getByRole("link", { name: /^E1/ })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await exercises.getByRole("link", { name: /^M1/ }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${PREVIEW}/preview/M1`);
  await expect(main.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(main.getByRole("heading", { level: 1 })).toContainText("M1");
  await page.getByRole("link", { name: /^Next: L1/ }).click();
  await expect(page).toHaveURL(`${PREVIEW}/preview/L1`);
  await page.goBack();
  await expect(main.getByRole("heading", { level: 1 })).toContainText("M1");

  await page.goto(`${PREVIEW}/preview/Z9`);
  await expect(page.getByText("No exercise Z9 in this study")).toBeVisible();
  expect(policyViolations).toEqual([]);
});
