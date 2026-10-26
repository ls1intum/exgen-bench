import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { unzipSync } from "fflate";

import { sha256 } from "../../../src/core/canonical.ts";

/**
 * Run the study's analysis (analysis.R) on an export, inside the container that pins R and its
 * packages. The report depends only on data.json, the seed, and that container, so `check` can
 * regenerate a committed report and fail on any difference.
 */

const ANALYSIS_DIRECTORY = import.meta.dir;
/** The seed of the bootstrap intervals, fixed before any rater answers. */
export const ANALYSIS_SEED = 20261026;

async function run(command: string[]): Promise<string> {
  const child = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${command.slice(0, 2).join(" ")} failed:\n${stderr.trim() || stdout.trim()}`);
  }
  return stdout;
}

/** The analysis image, built once per version of its Dockerfile and analysis.R. */
async function analysisImage(): Promise<string> {
  const files = await Promise.all(
    ["Dockerfile", "analysis.R"].map((name) => readFile(join(ANALYSIS_DIRECTORY, name))),
  );
  const tag = `exgen-survey-analysis:${sha256(files.map((file) => sha256(file)).join("\n")).slice(0, 16)}`;
  const present = Bun.spawn(["docker", "image", "inspect", tag], {
    stdout: "ignore",
    stderr: "ignore",
  });
  if ((await present.exited) !== 0) {
    await run(["docker", "build", "--quiet", "--tag", tag, ANALYSIS_DIRECTORY]);
  }
  return tag;
}

/** The data.json of an export ZIP, or the file itself. */
async function exportData(input: string): Promise<Uint8Array> {
  const bytes = new Uint8Array(await readFile(input));
  if (!input.endsWith(".zip")) {
    return bytes;
  }
  const data = unzipSync(bytes, { filter: (file) => file.name === "data.json" })["data.json"];
  if (data === undefined) {
    throw new Error(`${input} holds no data.json; is it an exgen survey export?`);
  }
  return data;
}

async function files(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    const path = join(entry.parentPath, entry.name);
    result.set(relative(directory, path), await readFile(path, "utf8"));
  }
  return result;
}

export interface ReportOptions {
  seed?: number;
  /** Compare with the report already in the output directory instead of writing it. */
  check?: boolean;
}

/** Write REPORT.md and tables/ for an export; with `check`, return the files that differ. */
export async function surveyReport(
  input: string,
  output: string,
  { seed = ANALYSIS_SEED, check = false }: ReportOptions = {},
): Promise<string[]> {
  const image = await analysisImage();
  const work = await mkdtemp(join(tmpdir(), "exgen-survey-report-"));
  try {
    const data = await exportData(resolve(input));
    await writeFile(join(work, "data.json"), data);
    await mkdir(join(work, "report"));
    await run([
      "docker",
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--volume",
      `${work}:/work`,
      "--env",
      `SURVEY_ANALYSIS_SEED=${seed}`,
      "--env",
      `SURVEY_ANALYSIS_INPUT_SHA256=${sha256(data)}`,
      image,
      "/work/data.json",
      "/work/report",
    ]);
    const produced = await files(join(work, "report"));
    if (check) {
      const committed = new Map(
        [...(await files(resolve(output)))].filter(
          ([path]) => path === "REPORT.md" || path.startsWith("tables/"),
        ),
      );
      return [...new Set([...produced.keys(), ...committed.keys()])]
        .filter((path) => produced.get(path) !== committed.get(path))
        .sort();
    }
    // Replace only what the analysis writes, so the report can sit next to the export it reads.
    await rm(join(resolve(output), "tables"), { recursive: true, force: true });
    for (const [path, content] of produced) {
      await mkdir(join(resolve(output), path, ".."), { recursive: true });
      await writeFile(join(resolve(output), path), content);
    }
    return [];
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
