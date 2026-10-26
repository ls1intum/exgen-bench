import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { sha256 } from "../../../src/core/canonical.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const WEB_DIRECTORY = resolve(import.meta.dir, "dist");
const STAMP = join(WEB_DIRECTORY, ".sources.sha256");

/** Everything the browser app is built from, so a stale build is detected rather than served. */
const SOURCES = [
  "tools/tier3-expert-rating/web/**/*.{ts,tsx,css,html}",
  "tools/tier3-expert-rating/shared/**/*.ts",
  "site/src/components/ui/**/*.tsx",
  "site/src/theme.css",
  "bun.lock",
];

async function sourceDigest(): Promise<string> {
  const paths = new Set<string>();
  for (const pattern of SOURCES) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: ROOT })) {
      if (!path.includes("/dist/") && !path.includes("node_modules")) paths.add(path);
    }
  }
  const parts: string[] = [];
  for (const path of [...paths].sort()) {
    parts.push(`${path}\0${sha256(await readFile(join(ROOT, path)))}`);
  }
  return sha256(parts.join("\n"));
}

/** Build the survey's browser app into `dist/`, which `exgen survey serve` serves. */
export async function buildSurveyWeb(): Promise<string> {
  // Vite is a development dependency; the import stays here so serving a current build needs none.
  const { build } = await import("vite");
  await build({ configFile: resolve(import.meta.dir, "vite.config.ts"), logLevel: "warn" });
  await writeFile(STAMP, `${await sourceDigest()}\n`);
  return WEB_DIRECTORY;
}

/** The built browser app, rebuilt only when its sources changed since the last build. */
export async function currentSurveyWeb(): Promise<string> {
  const built = await readFile(STAMP, "utf8").catch(() => "");
  return built.trim() === (await sourceDigest()) ? WEB_DIRECTORY : buildSurveyWeb();
}

if (import.meta.main) {
  process.stdout.write(`${await buildSurveyWeb()}\n`);
}
