import { expect, test } from "@playwright/test";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

test("keeps the public project preview stable", async ({ page }) => {
  const source = resolve(import.meta.dirname, "../site/social-preview.html");
  const image = resolve(import.meta.dirname, "../site/social-preview.png");
  expect((await stat(image)).size).toBeLessThan(1_000_000);
  await page.goto(pathToFileURL(source).href);
  await page.evaluate(() => document.fonts.ready);
  const dimensions = await page.evaluate(
    (url) =>
      new Promise<{ width: number; height: number }>((resolveDimensions, reject) => {
        const preview = new Image();
        preview.onload = () =>
          resolveDimensions({ width: preview.naturalWidth, height: preview.naturalHeight });
        preview.onerror = () => reject(new Error("Could not load the project preview"));
        preview.src = url;
      }),
    pathToFileURL(image).href,
  );
  expect(dimensions).toEqual({ width: 1280, height: 640 });
  await expect(page).toHaveScreenshot(["site", "social-preview.png"]);
});
