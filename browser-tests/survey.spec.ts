import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { strFromU8, unzipSync } from "fflate";

import { rubricSha256 } from "../tools/tier2-judge/llm-judge/staged/prompt.ts";
import { loadInstrumentVersion } from "../tools/tier3-expert-rating/builder/study.ts";
import { instrumentSourceSchema } from "../tools/tier3-expert-rating/shared/instrument.ts";

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
    // Base UI gives its invisible focus sentinels a button role on macOS WebKit so VoiceOver
    // triggers the focus trap. The survey's actual controls still go through the name check.
    .exclude("[data-base-ui-focus-guard]")
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    results.violations.map((violation) => ({ id: violation.id, nodes: violation.nodes })),
  ).toEqual([]);
}

/** Rating pages have one document scroll, including the material and template file list. */
async function expectPageScroll(page: Page) {
  const layout = await page.evaluate(() => ({
    documentScrolls: document.documentElement.scrollHeight > window.innerHeight,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    nestedScrolls: [...document.querySelectorAll("main *")].filter((element) => {
      const style = getComputedStyle(element);
      return /auto|scroll/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
    }).length,
  }));
  expect(layout).toEqual({ documentScrolls: true, horizontalOverflow: false, nestedScrolls: 0 });
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
  // The whole study, from consent to the briefs, in one test; slow runners need the margin.
  test.setTimeout(300_000);
  const rater = RATER[info.project.name];
  test.skip(rater === undefined, "the survey runs in the three browser projects");
  const policyViolations: string[] = [];
  page.on("console", (message) => {
    if (/content security policy/i.test(message.text())) policyViolations.push(message.text());
  });
  // A violation the page catches, such as a probe for `eval`, may log nothing; its event says it.
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`Content Security Policy: ${event.violatedDirective} at ${event.sourceFile}`);
    });
  });

  await page.goto((await links())[rater as string] as string);
  await expect(page).toHaveURL(`${SURVEY}/`);
  await expect(page.getByRole("heading", { name: "Welcome to the expert study" })).toBeVisible();
  await expectAccessible(page);
  const site = await (await page.request.get(`${SURVEY}/api/site`)).json();
  await expect(page.getByRole("link", { name: /^Contact / })).toHaveAttribute(
    "href",
    `mailto:${site.contact.email}`,
  );
  // Before consenting, a rater can read how the survey handles their data.
  await expect(page.getByRole("link", { name: "privacy notice" })).toHaveAttribute(
    "href",
    "/legal/privacy",
  );
  const agree = page.getByRole("button", { name: "Agree and start" });
  await expect(agree).toBeDisabled();
  for (const box of await page.getByRole("checkbox").all()) await box.click();
  await agree.click();

  // The introduction comes first, before any question.
  await expect(page.getByRole("heading", { name: "Purpose of the study" })).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  // The placeholders are filled in: the four parts' minutes, and the materiality rule.
  await expect(page.getByRole("heading", { name: "How a rating works" })).toBeVisible();
  await expect(page.getByText(/about 25 minutes per exercise/)).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByRole("heading", { name: "Answering the questions" })).toBeVisible();
  await expect(page.getByText(/materiality_rule/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Which problems count?" })).toBeVisible();
  await expect(page.getByText(/make an introductory programming student spend/)).toBeVisible();
  await expect(page.getByText(/the answer is Yes if it did/)).toBeVisible();
  await expect(page.getByText(/For borderline cases|Answer No if the problem/)).toHaveCount(0);
  await expect(page.getByRole("row", { name: /A cosmetic issue/ })).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Continue to the questions about you" }).click();

  // Each new step takes the focus to its heading and names itself in the window's title.
  await expect(page.getByRole("heading", { name: "About you" })).toBeFocused();
  await expect(page).toHaveTitle(/^About you · /);
  await page.getByRole("button", { name: "Submit", exact: true }).click();
  // A submit with open questions shows a summary that links to them, and marks each one.
  await expect(page.getByText(/questions need an answer/)).toBeVisible();
  await expect(page.getByRole("link", { name: "B1" })).toBeVisible();
  await expect(page.getByText("Choose at least one option.").first()).toBeVisible();
  // "None so far" excludes the other courses, and another course clears it again.
  const b3 = page.getByRole("group", { name: /B3/ });
  await b3.getByRole("checkbox", { name: "None so far" }).click();
  await b3.getByRole("checkbox", { name: "Software engineering" }).click();
  await expect(b3.getByRole("checkbox", { name: "None so far" })).not.toBeChecked();
  await expect(b3.getByRole("checkbox", { name: "Software engineering" })).toBeChecked();
  await answerAll(page);
  await expectAccessible(page);
  await submit(page, /^Submit$/);

  for (const position of [1, 2]) {
    await expect(page.getByRole("heading", { name: `Exercise ${position} of 2` })).toBeVisible();
    await expect(page.getByText(/about 25 minutes/)).toBeVisible();
    await page.getByRole("button", { name: "Start Part A" }).click();
    await expect(page.getByRole("heading", { name: "Part A · Problem statement" })).toBeVisible();
    if (position === 1) {
      // The first exercise opens with a tour of the screen, starting with the questions; it can be
      // skipped at any stop.
      const tour = page.getByRole("dialog", { name: "Questions for this part" });
      await expect(tour).toBeVisible();
      await expect(tour.getByRole("button", { name: "Next" })).toBeFocused();
      await expectAccessible(page);
      await tour.getByRole("button", { name: "Next" }).click();
      const brief = page.getByRole("dialog", { name: "The brief" });
      await expect(brief).toBeVisible();
      await brief.getByRole("button", { name: "Next" }).click();
      await page
        .getByRole("dialog", { name: "The problem statement" })
        .getByRole("button", { name: "Next" })
        .click();
      await page
        .getByRole("dialog", { name: "More material, part by part" })
        .getByRole("button", { name: "Next" })
        .click();
      const rule = page.getByRole("dialog", { name: "Which problems count?" });
      await expect(rule).toBeVisible();
      await rule.getByRole("button", { name: "Skip tour" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    const guidance = page.getByRole("complementary", { name: "Which problems count?" });
    await expect(
      guidance.getByText(
        /could make an introductory programming student spend noticeable extra time/,
      ),
    ).toBeVisible();
    // The header names the exercise and its phase; what the automatic checks confirmed is in the
    // introduction, not repeated on every exercise.
    await expect(page.getByText(/Early phase|Middle phase|Late phase/).first()).toBeVisible();
    await expect(page.getByText(/Solution passes all/)).toHaveCount(0);
    if (position === 1) {
      // The demo's first exercise has a class diagram, which the browser draws with PlantUML.
      const diagram = page.getByRole("img", { name: "Diagram 1" });
      await expect(diagram).toBeVisible({ timeout: 30_000 });
      expect(
        await diagram.evaluate((image: HTMLImageElement) => image.naturalWidth),
      ).toBeGreaterThan(100);
      // Expanded, the diagram fills the window on the same page, and Escape returns to the
      // problem statement.
      const expand = page.getByRole("button", { name: "Expand Diagram 1" });
      await expand.click();
      const view = page.getByRole("dialog", { name: "Diagram 1" });
      await expect(view.getByRole("img", { name: "Diagram 1" })).toBeVisible();
      await expect(view).toHaveCSS("opacity", "1");
      await expectAccessible(page);
      await view.getByRole("button", { name: "Actual size" }).click();
      const fit = view.getByRole("button", { name: "Fit to window" });
      await expect(fit).toBeVisible();
      await view.getByRole("button", { name: "Close" }).focus();
      await page.keyboard.press("Tab");
      await expect(fit).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(view).toBeHidden();
      await expect(expand).toBeFocused();

      // A No asks where, with a hint of what is enough; Part D shows the answer with its question.
      const cl1 = page.getByRole("group", { name: /CL1/ });
      await cl1.getByRole("radio", { name: "No" }).click();
      const where = cl1.getByRole("textbox", { name: "Where" });
      await expect(where).toHaveAttribute("placeholder", "A task or a sentence is enough.");
      await where.fill("Task 2 leaves the upper bound open.");
    }
    if (position === 1) {
      const viewport = page.viewportSize()!;
      await expectPageScroll(page);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.getByRole("tab", { name: "Material", exact: true })).toBeVisible();
      await expectPageScroll(page);
      await page.getByRole("tab", { name: /^Questions ·/ }).click();
      await expect(page.getByRole("heading", { name: "Part A · Problem statement" })).toBeVisible();
      await expect(guidance).toBeVisible();
      await expectPageScroll(page);
      await page.setViewportSize(viewport);
      await expectPageScroll(page);
    }
    await expect(page.getByRole("tab", { name: /Template/ })).toBeDisabled();
    await expect(page.getByRole("tab", { name: /Problem statement/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByRole("tab", { name: /Brief/ }).click();
    await expect(
      page.getByText("The instructor's brief, which the AI pipeline received as its input."),
    ).toBeVisible();
    if (position === 2) {
      // The tour shows once: the second exercise opens without it, and it can be shown again.
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await page.getByRole("button", { name: "Show the tour" }).click();
      await expect(page.getByRole("dialog", { name: "Questions for this part" })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    }
    await answerAll(page);
    await submit(page, "Submit Part A");

    await expect(
      page.getByRole("heading", { name: "Part B · Template and solution changes" }),
    ).toBeFocused();
    await expect(page).toHaveTitle(new RegExp(`^Exercise ${position} of 2 · Part B · `));
    await expect(page.getByRole("tab", { name: /Template/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("navigation", { name: "Template files" })).toBeVisible();
    await expect(guidance).toBeVisible();
    await expectPageScroll(page);
    // Earlier answers are shown only in Part D, where remarks on them are asked for.
    await expect(page.getByRole("region", { name: /^Your answers in/ })).toHaveCount(0);
    if (position === 1) await expectAccessible(page);
    await page.getByRole("tab", { name: /Solution changes/ }).click();
    await expect(page.getByText("Added:").first()).toBeAttached();
    // Comments keep their contrast on the tinted lines of the diff.
    if (position === 1) await expectAccessible(page);
    await answerAll(page);
    await submit(page, "Submit Part B");

    await expect(page.getByRole("heading", { name: "Part C · Tests" })).toBeVisible();
    await expect(guidance).toBeVisible();
    await expect(page.getByRole("tab", { name: /Tests/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("region", { name: /^Your answers in/ })).toHaveCount(0);
    await answerAll(page);
    await submit(page, "Submit Part C");

    await expect(page.getByRole("heading", { name: "Part D · Automatic findings" })).toBeVisible();
    await expect(guidance).toBeVisible();
    const af1 = page.getByRole("group", { name: /AF1/ });
    const af1Hint = af1.getByText(/if at least one finding reveals a problem/);
    await expect(af1Hint).toBeVisible();
    if (position === 1) {
      // A replay from the material pane switches to the questions to explain AF1 and restores
      // the original pane on exit, even after resizing while the rule stop is active.
      const viewport = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      const materialTab = page.getByRole("tab", { name: "Material", exact: true });
      const questionsTab = page.getByRole("tab", { name: /^Questions ·/ });
      await materialTab.click();
      await page.getByRole("button", { name: "Show the tour" }).click();
      for (const title of ["Questions for this part", "The brief", "The problem statement"]) {
        const stop = page.getByRole("dialog", { name: title });
        await stop.getByRole("button", { name: "Next" }).click();
      }
      const rule = page.getByRole("dialog", { name: "Which problems count?" });
      await expect(rule).toBeVisible();
      await expect(questionsTab).toHaveAttribute("aria-selected", "true");
      await expect(guidance).toBeVisible();
      await page.setViewportSize(viewport);
      await expect(rule.getByRole("button", { name: "Next" })).toBeFocused();
      await rule.getByRole("button", { name: "Next" }).click();
      const findingsStop = page.getByRole("dialog", {
        name: "When a finding reveals a new problem",
      });
      await expect(
        findingsStop.getByText(/Answer Yes if a finding revealed a problem/),
      ).toBeVisible();
      await expect(findingsStop.getByRole("button", { name: "Next" })).toBeFocused();
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(findingsStop.getByRole("button", { name: "Next" })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(materialTab).toHaveAttribute("aria-selected", "true");
      await questionsTab.click();
      await expect(af1Hint).toBeVisible();
      await expectAccessible(page);
      await page.setViewportSize(viewport);

      const which = af1.getByRole("textbox", { name: "Which findings revealed new problems?" });
      await af1.getByRole("radio", { name: "Yes", exact: true }).click();
      await expect(which).toBeFocused();
      await which.fill("Finding about a missing test case.");
      await af1.getByRole("radio", { name: /^N\/A/ }).click();
      await expect(which).toHaveCount(0);

      const af2 = page.getByRole("group", { name: /AF2/ });
      await af2.getByRole("radio", { name: "No", exact: true }).click();
      await af2.getByRole("textbox", { name: "Which finding and why" }).fill("F2 is unrelated.");
    }
    await expect(page.getByRole("heading", { name: "Findings", exact: true })).toBeVisible();
    await expect(page.getByRole("list", { name: "Finding categories", exact: true })).toBeVisible();
    for (const category of ["Consistency", "Solution", "Tests"])
      await expect(
        page
          .getByRole("list", { name: "Finding categories", exact: true })
          .getByRole("heading", { name: category, exact: true }),
      ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Measurements", exact: true }),
    ).not.toBeVisible();
    await page.getByText("Evidence and measurements", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Measurements", exact: true })).toBeVisible();
    await expect(page.getByText(/Cognitive demand, clarity, teaching value/)).toBeVisible();
    // The earlier answers stand with their questions right before the remarks on them.
    const earlier = page.getByRole("region", { name: "Your answers in Parts A to C" });
    await expect(earlier).toBeVisible();
    await expect(earlier.locator("xpath=following-sibling::*[1]")).toHaveAttribute(
      "id",
      "item-REM",
    );
    for (const heading of [
      "Part A · Problem statement",
      "Part B · Template and solution changes",
      "Part C · Tests",
    ]) {
      await expect(earlier.getByRole("heading", { name: heading })).toBeVisible();
    }
    await expect(
      earlier.getByText(
        "Is every required behaviour stated so that only one reasonable reading exists?",
      ),
    ).toBeVisible();
    if (position === 1) {
      await expect(earlier.getByText("Where: Task 2 leaves the upper bound open.")).toBeVisible();
      await expectAccessible(page);
    }
    await answerAll(page);
    await submit(page, "Submit Part D");
  }

  await expect(page.getByRole("heading", { name: "Looking back" })).toBeFocused();
  await answerAll(page);
  await submit(page, /^Submit$/);

  // Only the two assigned briefs appear, numbered to match the exercises.
  await expect(page.getByRole("heading", { name: "The briefs", level: 1 })).toBeVisible();
  const briefs = page.getByRole("list", { name: "Briefs" }).locator(":scope > li");
  await expect(briefs).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Brief 1 · Late phase" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Brief 2 · Early phase" })).toBeVisible();
  await page.reload();
  await expect(briefs).toHaveCount(2);
  await expectAccessible(page);
  await answerAll(page);
  await submit(page, /^Submit$/);
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Thank you" })).toBeVisible();
  const saved = await page.request.get(`${SURVEY}/api/me/answers.json`);
  expect(saved.ok()).toBe(true);
  const answers = await saved.json();
  expect(answers.rater).toBe(rater);
  expect(answers.steps).toHaveLength(13);
  expect(
    answers.steps.find((step: { step: string }) => step.step === "exercise-1-D").answers,
  ).toMatchObject({
    AF1: { value: "na" },
    AF2: { value: "no", text: "F2 is unrelated." },
  });
  expect(
    answers.steps.find((step: { step: string }) => step.step === "briefs").answers,
  ).toMatchObject({
    BR1: { value: "yes" },
    BR2: { value: "yes" },
    BR3: { text: "A short reason." },
  });
  expect(answers.steps.every((step: { submitted_at: string }) => Boolean(step.submitted_at))).toBe(
    true,
  );
  // Inspect the study export with an independent admin session and compare its persisted answers.
  const team = await page.context().browser()!.newContext();
  try {
    await team.request.get((await links()).admin as string);
    const exported = await team.request.get(`${SURVEY}/api/admin/export.zip?role=test`);
    expect(exported.ok()).toBe(true);
    const files = unzipSync(new Uint8Array(await exported.body()));
    const data = JSON.parse(strFromU8(files["data.json"]!));
    const row = data.tables.briefs.find((entry: { rater_id: string }) => entry.rater_id === rater);
    expect(row).toMatchObject({ BR1: "yes", BR2: "yes", BR3: "A short reason." });
    expect(strFromU8(files["briefs.csv"]!)).toContain(`${rater},test,`);
    expect(strFromU8(files["CODEBOOK.md"]!)).toContain("rater-specific numbers");
  } finally {
    await team.close();
  }

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

  // The frozen material as raters see it, read-only, and back to the dashboard.
  await page.getByRole("tab", { name: /^Exercises/ }).click();
  await page.getByRole("link", { name: "Preview M1" }).click();
  await expect(page).toHaveURL(`${SURVEY}/preview/M1`);
  await expect(page.getByRole("note")).toContainText("nothing is recorded");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("M1");
  await expect(
    page.getByRole("heading", { level: 3, name: "Findings", exact: true }).first(),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("link", { name: "Back to the dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Study dashboard" })).toBeAttached();
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

test("the exercise preview tells visitors without the study team's link only that it is not for them", async ({
  page,
}) => {
  await page.goto(`${SURVEY}/preview`);
  await expect(
    page.getByRole("heading", { name: "This page is for the study team", level: 1 }),
  ).toBeVisible();
  await expect(page.locator("body")).not.toContainText("exgen");
  await expect(page.getByRole("navigation", { name: "Exercises" })).toHaveCount(0);
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

test("the V7 reviewer can find the right material and finish without the briefs page", async ({
  page,
  browser,
}, info) => {
  test.skip(info.project.name !== "chromium", "one browser exercises the versioned survey path");
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  const demo = await links();
  const team = await browser.newContext();
  try {
    const admin = await team.newPage();
    await admin.goto(demo.admin!);
    const assignment = await team.request.post(`${SURVEY}/api/admin/assign`, {
      headers: { Origin: SURVEY },
      data: { rater: "R2", kind: "additional", exercises: ["E1"] },
    });
    expect(assignment.ok()).toBe(true);
  } finally {
    await team.close();
  }

  await page.goto(demo.R2!);
  await expect(page.getByRole("heading", { name: "Welcome to the expert study" })).toBeVisible();
  for (const box of await page.getByRole("checkbox").all()) await box.click();
  await page.getByRole("button", { name: "Agree and start" }).click();
  await expect(page.getByRole("heading", { name: "How the review works" })).toBeVisible();
  await expect(page.getByText(/The task asks students to convert Celsius readings/)).toBeVisible();
  await page.getByRole("button", { name: "Continue to the questions about you" }).click();
  await expect(page.getByRole("heading", { name: "About you" })).toBeVisible();
  await answerAll(page);
  await submit(page, /^Submit$/);

  await page.setViewportSize({ width: 390, height: 780 });
  await page.getByRole("button", { name: "Start Part A" }).click();
  const tour = page.getByRole("dialog", { name: "Material and questions" });
  await expect(tour).toBeVisible();
  await tour.getByRole("button", { name: "Next" }).click();
  const helpStop = page.getByRole("dialog", { name: "An example if you need it" });
  await expect(helpStop).toBeVisible();
  await helpStop.getByRole("button", { name: "Skip tour" }).click();

  await expect(page.getByRole("tab", { name: "Prompt" })).toHaveCount(0);
  const firstSession = await (await page.request.get(`${SURVEY}/api/session`)).json();
  expect(Object.keys(firstSession.step.exercise).sort()).toEqual([
    "id",
    "phase",
    "statement",
    "template",
  ]);
  expect(firstSession.step.exercise.statement).not.toContain("[task:untested]");
  expect(firstSession.step.earlier).toEqual({});
  expect(rubricSha256(instrumentSourceSchema.parse(firstSession.instrument))).toBe(
    rubricSha256(await loadInstrumentVersion("7")),
  );
  await page.getByRole("tab", { name: "Starter code", exact: true }).click();
  await page.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.getByRole("button", { name: /pom\.xml/ })).toHaveCount(0);
  await page.getByRole("button", { name: "Build and setup files (3)" }).click();
  await page.getByRole("button", { name: "pom.xml", exact: true }).click();
  await expect(page.getByRole("region", { name: "pom.xml", exact: true })).toBeVisible();

  await page.getByRole("tab", { name: /^Questions ·/ }).click();
  await expect(page.getByRole("heading", { name: "Part A · Student instructions" })).toBeVisible();
  const example = page.getByText("See an example", { exact: true });
  await example.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByText(/The task asks students to convert Celsius readings/)).toBeVisible();
  await expectAccessible(page);
  await answerAll(page);
  await submit(page, "Submit Part A");

  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.getByRole("heading", { name: "Part B · Teaching fit" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Prompt", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "Tests", exact: true })).toHaveCount(0);
  await answerAll(page);
  await submit(page, "Submit Part B");

  await expect(page.getByRole("heading", { name: "Part C · Tests and readiness" })).toBeVisible();
  await page.getByRole("radio", { name: /Local fix/ }).click();
  await page
    .getByRole("textbox", { name: /What’s the main change/ })
    .fill("Define the output unit.");
  await answerAll(page);
  await submit(page, "Submit Part C");

  await expect(page.getByRole("heading", { name: "Part D · Automatic findings" })).toBeVisible();
  await expect(page.getByText("See your previous decision")).toHaveCount(0);
  await expect(page.getByRole("radio", { name: /Local fix/ })).not.toBeChecked();
  await page.getByRole("radio", { name: /Local fix/ }).click();
  await page.getByText("See your previous decision", { exact: true }).click();
  await page.getByRole("button", { name: "Reuse this repair" }).click();
  await expect(page.getByRole("textbox", { name: /What’s the main change/ })).toHaveValue(
    "Define the output unit.",
  );
  await page.getByRole("radio", { name: /Nothing that affected a fix/ }).click();
  await expectAccessible(page);
  await submit(page, "Submit Part D");

  await expect(page.getByRole("heading", { name: "Looking back", exact: true })).toBeVisible();
  await submit(page, /^Submit$/);
  await expect(page.getByRole("heading", { name: "Thank you", exact: true })).toBeVisible();
  const exported = await (await page.request.get(`${SURVEY}/api/me/answers.json`)).json();
  expect(exported.steps.map((step: { step: string }) => step.step)).not.toContain("briefs");
  const findings = exported.steps.find((step: { step: string }) => step.step === "exercise-1-D");
  expect(findings.answers.RD2).toEqual({ value: 3, text: "Define the output unit." });
});
