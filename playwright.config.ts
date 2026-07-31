import { defineConfig, devices } from "@playwright/test";

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
      testIgnore: /social-preview\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      testIgnore: /social-preview\.spec\.ts/,
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      testIgnore: /social-preview\.spec\.ts/,
      use: { ...devices["Desktop Safari"] },
    },
    ...(process.env.CI || process.env.EXGEN_VISUAL_TESTS
      ? [
          {
            name: "visual-chromium",
            retries: 0,
            testMatch: /social-preview\.spec\.ts/,
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
              locale: "en-US",
              reducedMotion: "reduce",
              timezoneId: "UTC",
              viewport: { width: 1280, height: 640 },
            },
          },
        ]
      : []),
  ],
  webServer: {
    command: "bun run site:serve",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
  },
});
