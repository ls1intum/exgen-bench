import { resolve } from "node:path";

import { build } from "vite";

const WEB_DIRECTORY = resolve(import.meta.dir, "dist");

/** Build the survey's browser app into `dist/`, which `exgen survey serve` serves. */
export async function buildSurveyWeb(): Promise<string> {
  await build({ configFile: resolve(import.meta.dir, "vite.config.ts"), logLevel: "warn" });
  return WEB_DIRECTORY;
}
