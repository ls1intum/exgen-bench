import { expect, type Page, test } from "@playwright/test";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

async function expectProjectImage(
  page: Page,
  options: {
    source: string;
    image: string;
    snapshot: string[];
    width: number;
    height: number;
  },
) {
  const source = resolve(import.meta.dirname, options.source);
  const image = resolve(import.meta.dirname, options.image);

  await page.setViewportSize({ width: options.width, height: options.height });
  await page.goto(pathToFileURL(source).href);
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot(options.snapshot);

  expect((await stat(image)).size).toBeLessThan(1_000_000);
  const dimensions = await page.evaluate(
    (url) =>
      new Promise<{ width: number; height: number }>((resolveDimensions, reject) => {
        const preview = new Image();
        preview.onload = () =>
          resolveDimensions({ width: preview.naturalWidth, height: preview.naturalHeight });
        preview.onerror = () => reject(new Error("Could not load the project image"));
        preview.src = url;
      }),
    pathToFileURL(image).href,
  );
  expect(dimensions).toEqual({ width: options.width, height: options.height });
}

test("keeps the public project preview stable", async ({ page }) => {
  await expectProjectImage(page, {
    source: "../site/social-preview.html",
    image: "../site/social-preview.png",
    snapshot: ["site", "social-preview.png"],
    width: 1280,
    height: 640,
  });
});

test("keeps the system overview stable", async ({ page }) => {
  await expectProjectImage(page, {
    source: "../docs/figures/system-overview.html",
    image: "../docs/images/system-overview.png",
    snapshot: ["docs", "images", "system-overview.png"],
    width: 1600,
    height: 900,
  });
});
