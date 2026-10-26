import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * The expert survey end to end, against the demo study `bun run survey:demo` builds and serves. Each
 * browser rates as its own test rater, so the projects run side by side without sharing a session.
 */

const SURVEY = "http://127.0.0.1:4180";
const RATER: Record<string, string> = { chromium: "T1", firefox: "T2", webkit: "T3" };

async function links(): Promise<Record<string, string>> {
  return JSON.parse(await readFile(".exgen/survey-demo/links.json", "utf8"));
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(results.violations.map((violation) => violation.id)).toEqual([]);
}

/** Answer every item on the page with its first option, and give a reason wherever one is asked. */
async function answerAll(page: Page) {
  for (const group of await page.getByRole("radiogroup").all()) {
    if ((await group.getByRole("radio", { checked: true }).count()) === 0) {
      await group.getByRole("radio").first().click();
    }
  }
  for (const set of await page.locator("fieldset").all()) {
    const boxes = set.getByRole("checkbox");
    if (
      (await boxes.count()) > 0 &&
      (await set.getByRole("checkbox", { checked: true }).count()) === 0
    ) {
      await boxes.first().click();
    }
  }
  for (const field of await page.locator("textarea").all()) {
    if ((await field.inputValue()) === "") await field.fill("A short reason.");
  }
}

async function submit(page: Page, label: string | RegExp) {
  await page.getByRole("button", { name: label }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Submit", exact: true }).click();
}

test("a rater completes the study from consent to download", async ({ page }, info) => {
  test.setTimeout(120_000);
  const rater = RATER[info.project.name];
  test.skip(rater === undefined, "the survey runs in the three browser projects");
  const policyViolations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) policyViolations.push(message.text());
  });

  await page.goto((await links())[rater as string] as string);
  await expect(page).toHaveURL(`${SURVEY}/`);
  await expect(page.getByRole("heading", { name: "Welcome to the expert study" })).toBeVisible();
  await expectAccessible(page);
  const agree = page.getByRole("button", { name: "Agree and start" });
  await expect(agree).toBeDisabled();
  for (const box of await page.getByRole("checkbox").all()) await box.click();
  await agree.click();

  await expect(page.getByRole("heading", { name: "About you" })).toBeVisible();
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  // A submit with open questions shows a summary that links to them, and marks each one.
  await expect(page.getByText(/questions need an answer/)).toBeVisible();
  await expect(page.getByRole("link", { name: "B1" })).toBeVisible();
  await expect(page.getByText("Choose at least one option.").first()).toBeVisible();
  await answerAll(page);
  await expectAccessible(page);
  await submit(page, /^Submit$/);

  await expect(page.getByRole("heading", { name: "Purpose of the study" })).toBeVisible();
  for (let page_ = 0; page_ < 3; page_ += 1)
    await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Start the practice exercise" }).click();

  await expect(page.getByRole("heading", { name: "Practice exercise" })).toBeVisible();
  await expect(page.getByRole("tab", { name: /Findings/ })).toHaveCount(0);
  const cl1 = page.getByRole("group", { name: /CL1/ });
  await cl1.getByRole("radio", { name: "No" }).click();
  await cl1.getByRole("textbox", { name: "Where" }).fill("Whether the bounds are included.");
  await answerAll(page);
  await submit(page, "Submit and compare");
  await expect(
    page.getByRole("heading", { name: "How we read the practice exercise" }),
  ).toBeVisible();
  await expect(page.getByText("Same as ours")).toHaveCount(1);
  await page.getByRole("button", { name: "Continue to the exercises" }).click();

  for (const position of [1, 2]) {
    await expect(page.getByRole("heading", { name: `Exercise ${position} of 2` })).toBeVisible();
    await page.getByRole("button", { name: "Start Part A" }).click();
    await expect(page.getByRole("heading", { name: "Part A · Problem statement" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Template/ })).toBeDisabled();
    await expect(page.getByRole("tab", { name: /Problem statement/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await answerAll(page);
    await submit(page, "Submit Part A");

    await expect(
      page.getByRole("heading", { name: "Part B · Template and solution changes" }),
    ).toBeVisible();
    await expect(page.getByRole("tab", { name: /Template/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("navigation", { name: "Template files" })).toBeVisible();
    if (position === 1) await expectAccessible(page);
    await page.getByRole("tab", { name: /Solution changes/ }).click();
    await expect(page.getByText("Added:").first()).toBeAttached();
    await answerAll(page);
    await submit(page, "Submit Part B");

    await expect(page.getByRole("heading", { name: "Part C · Test overview" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Tests/ })).toHaveAttribute("aria-selected", "true");
    await answerAll(page);
    await submit(page, "Submit Part C");

    await expect(page.getByRole("heading", { name: "Part D · Automatic findings" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Findings", exact: true })).toBeVisible();
    await answerAll(page);
    await submit(page, "Submit Part D");
  }

  await expect(page.getByRole("heading", { name: "Final survey" })).toBeVisible();
  await answerAll(page);
  await submit(page, /^Submit$/);
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Answers as JSON" })).toHaveAttribute(
    "href",
    "/api/me/answers.json",
  );
  await expectAccessible(page);
  expect(policyViolations).toEqual([]);
});

test("the study team follows progress and downloads the export", async ({ page }, info) => {
  test.skip(info.project.name !== "chromium", "one browser is enough for the study team's view");
  await page.goto((await links()).admin as string);
  await expect(page).toHaveURL(`${SURVEY}/admin`);
  await expect(page.getByRole("heading", { name: "Raters" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Raters" }).getByRole("cell", { name: "R1", exact: true }),
  ).toBeVisible();
  await expectAccessible(page);
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download the export" }).click();
  expect((await download).suggestedFilename()).toBe("expert-rating-demo-export.zip");
});

test("an unknown link explains how to get in", async ({ page }) => {
  await page.goto(`${SURVEY}/r/not-a-valid-link`);
  await expect(page).toHaveURL(`${SURVEY}/`);
  await expect(page.getByText("Open your personal link")).toBeVisible();
  await expect(page.getByText(/ask the study team for a new one/)).toBeVisible();
});
