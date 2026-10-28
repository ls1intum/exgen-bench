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
  // The whole study, from consent to the final survey, in one test; slow runners need the margin.
  test.setTimeout(300_000);
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
  // Before consenting, a rater can read how the survey handles their data.
  await expect(page.getByRole("link", { name: "privacy notice" })).toHaveAttribute(
    "href",
    "/legal/privacy",
  );
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
    if (position === 1) {
      // The demo's first exercise has a class diagram, which the browser draws with PlantUML.
      const diagram = page.getByRole("img", { name: "Diagram 1" });
      await expect(diagram).toBeVisible({ timeout: 30_000 });
      expect(
        await diagram.evaluate((image: HTMLImageElement) => image.naturalWidth),
      ).toBeGreaterThan(100);
      // Expanded, the diagram fills the window on the same page, and Escape returns to the statement.
      const expand = page.getByRole("button", { name: "Expand Diagram 1" });
      await expand.click();
      const view = page.getByRole("dialog", { name: "Diagram 1" });
      await expect(view.getByRole("img", { name: "Diagram 1" })).toBeVisible();
      await expectAccessible(page);
      await view.getByRole("button", { name: "Actual size" }).click();
      await expect(view.getByRole("button", { name: "Fit to window" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(view).toBeHidden();
      await expect(expand).toBeFocused();
    }
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

test("the study team manages raters and assignments, and downloads the export", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "chromium", "one browser is enough for the study team's view");
  await page.goto((await links()).admin as string);
  await expect(page).toHaveURL(`${SURVEY}/admin`);
  const raters = page.getByRole("region", { name: "Raters" });
  await expect(raters.getByText("R1", { exact: true })).toBeVisible();
  await expectAccessible(page);

  // A pilot rater joins and rates a study exercise; their link is shown once.
  await page.getByRole("button", { name: "Add rater" }).click();
  const add = page.getByRole("dialog", { name: "Add a rater" });
  await add.getByRole("checkbox", { name: /^M1/ }).click();
  await expectAccessible(page);
  await add.getByRole("button", { name: /^Add P\d+$/ }).click();
  const shown = page.getByRole("dialog", { name: /^Personal link for P\d+$/ });
  await expect(shown.getByRole("textbox", { name: "Personal link" })).toHaveValue(
    new RegExp(`^${SURVEY}/r/`),
  );
  await page.keyboard.press("Escape");
  await expect(raters.getByText(/Pilot · added/).first()).toBeVisible();

  // An assignment nobody started can be removed again.
  await page.getByRole("button", { name: "Actions for R1" }).click();
  await page.getByRole("menuitem", { name: "Remove assignments…" }).click();
  const remove = page.getByRole("dialog", { name: "Remove assignments of R1" });
  await remove.getByRole("checkbox", { name: /^L1/ }).click();
  await remove.getByRole("button", { name: "Remove L1" }).click();
  await expect(remove).toBeHidden();
  await expect(raters.getByRole("row", { name: /R1/ }).getByText("L1")).toHaveCount(0);

  await page.getByRole("tab", { name: /^Changes/ }).click();
  await expect(page.getByRole("cell", { name: "rater added" }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "assignment removed" })).toBeVisible();
  await page.getByRole("tab", { name: "Insights" }).click();
  await expect(page.getByRole("heading", { name: "Time per part" })).toBeVisible();
  await expectAccessible(page);

  await page.getByRole("tab", { name: "Export" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Download the export" }).click();
  expect((await download).suggestedFilename()).toBe("expert-rating-demo-export.zip");
});

test("an unknown link explains how to get in", async ({ page }) => {
  await page.goto(`${SURVEY}/r/not-a-valid-link`);
  await expect(page).toHaveURL(`${SURVEY}/`);
  await expect(
    page.getByRole("heading", { name: "Open your personal link", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(/ask the study team for a new one/)).toBeVisible();
  await expectAccessible(page);
});

test("every page links to the deployment's legal documents, readable without a link", async ({
  page,
}) => {
  await page.goto(`${SURVEY}/`);
  const legal = page.getByRole("navigation", { name: "Legal" });
  await expect(legal.getByRole("link", { name: "Imprint" })).toBeVisible();
  await legal.getByRole("link", { name: "Privacy" }).click();
  await expect(page).toHaveURL(`${SURVEY}/legal/privacy`);
  await expect(page.getByRole("heading", { name: "Privacy", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your rights", level: 2 })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("link", { name: "Back to the survey" }).click();
  await expect(page).toHaveURL(`${SURVEY}/`);
});
