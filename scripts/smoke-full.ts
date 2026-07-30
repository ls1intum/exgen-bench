import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateSite } from "../site/validate.ts";
import { releaseMetadataFileSchema } from "../src/export/release-metadata.ts";

const root = resolve(import.meta.dir, "..");
const runId = `smoke-${crypto.randomUUID()}`;
const runDirectory = join(root, ".exgen", "runs", runId);
const requestedOutput = process.env.EXGEN_SMOKE_OUTPUT;
const temporaryDirectory = requestedOutput
  ? resolve(requestedOutput)
  : await mkdtemp(join(tmpdir(), "exgen-full-smoke-"));
if (requestedOutput) {
  await mkdir(temporaryDirectory, { recursive: false });
}
const releaseDirectory = join(temporaryDirectory, "release");
const siteDirectory = join(temporaryDirectory, "site");
const cli = [process.execPath, "run", join(root, "src", "cli.ts")];
const releaseMetadata = releaseMetadataFileSchema.parse(
  await Bun.file(join(root, "examples/smoke/release.json")).json(),
);

async function command(arguments_: string[]): Promise<void> {
  const child = Bun.spawn([...cli, ...arguments_], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`smoke command failed with exit ${exitCode}: ${arguments_.join(" ")}`);
  }
}

try {
  await command(["run", "examples/smoke/benchmark.yaml", "--id", runId]);
  await command(["evaluate", "bundle", runDirectory]);
  await command([
    "release",
    "create",
    runDirectory,
    "--output",
    releaseDirectory,
    "--metadata",
    "examples/smoke/release.json",
    "--metric-cards",
    "examples/smoke/metric-cards.json",
  ]);
  await command(["release", "verify", releaseDirectory]);
  await command(["site", "build", releaseDirectory, "--output", siteDirectory]);
  const releases = await validateSite(siteDirectory);
  if (releases.length !== 1) {
    throw new Error(`expected one built smoke release, found ${releases.length}`);
  }
  const published = releases[0];
  if (
    published?.release_id !== releaseMetadata.id ||
    published?.status !== "exploratory" ||
    published.release_version !== releaseMetadata.version ||
    published.source_manifest_sha256?.length !== 64
  ) {
    throw new Error(
      "built release lost its release ID, designation, version, or source-manifest identity",
    );
  }
  if (
    !(await Bun.file(
      join(siteDirectory, "data", releaseMetadata.id, "source", "data", "scores.csv"),
    ).exists())
  ) {
    throw new Error("built site is missing an allowlisted score table");
  }
  if (
    (await Bun.file(
      join(siteDirectory, "data", releaseMetadata.id, "source", "data", "evaluations.jsonl"),
    ).exists()) ||
    (await Bun.file(
      join(siteDirectory, "data", releaseMetadata.id, "formal", "data", "evaluations.jsonl"),
    ).exists())
  ) {
    throw new Error("built site exposed the unrestricted evaluation journal");
  }
  process.stdout.write(`Full pipeline passed: ${runId}\n`);
} finally {
  await Promise.all([
    rm(runDirectory, { recursive: true, force: true }),
    ...(requestedOutput ? [] : [rm(temporaryDirectory, { recursive: true, force: true })]),
  ]);
}
