import { defineConfig, devices, type Project } from "@playwright/test";

/** Pixel-exact screenshots, pinned to one rendering environment so they are reproducible. */
const visualProject: Project = {
  name: "visual-chromium",
  retries: 0,
  testMatch: /project-visuals\.spec\.ts/,
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 0,
      pathTemplate: "{testDir}/../{arg}{ext}",
      threshold: 0,
    },
  },
  use: {
    ...devices["Desktop Chrome"],
    colorScheme: "light",
    deviceScaleFactor: 1,
    contextOptions: { reducedMotion: "reduce" },
    locale: "en-US",
    timezoneId: "UTC",
    viewport: { width: 1280, height: 640 },
  },
};

export default defineConfig({
  testDir: "./browser-tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: /project-visuals\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      testIgnore: /project-visuals\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: /project-visuals\.spec\.ts/,
      use: { ...devices["Desktop Safari"] },
    },
    ...(process.env.CI || process.env.EXGEN_VISUAL_TESTS ? [visualProject] : []),
  ],
  webServer: {
    command: "bun run site:serve",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
