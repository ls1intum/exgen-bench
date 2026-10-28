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

/**
 * The survey's tests need its server, which runs on a JVM against PostgreSQL in Docker; they run
 * with `bun run survey:browser-test`, and in CI in a job of their own.
 */
const survey = Boolean(process.env.EXGEN_SURVEY_TESTS);
const ignored = survey
  ? [/project-visuals\.spec\.ts/]
  : [/project-visuals\.spec\.ts/, /survey\.spec\.ts/];

export default defineConfig({
  testDir: "./browser-tests",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4173",
    // Without smooth scrolling, the scroll before a click ends before the click; Firefox missed clicks.
    contextOptions: { reducedMotion: "reduce" },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testIgnore: ignored,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      testIgnore: ignored,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: ignored,
      use: { ...devices["Desktop Safari"] },
    },
    ...(process.env.CI || process.env.EXGEN_VISUAL_TESTS ? [visualProject] : []),
  ],
  webServer: [
    {
      command: "bun run site:serve",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: !process.env.CI,
      timeout: 15_000,
    },
    ...(survey
      ? [
          {
            // Generates, evaluates, builds and serves the demo study, so it takes longer to start.
            command: "bun run survey:demo",
            url: "http://127.0.0.1:4180",
            reuseExistingServer: !process.env.CI,
            timeout: 300_000,
          },
        ]
      : []),
  ],
});
