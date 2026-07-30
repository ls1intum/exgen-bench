#!/usr/bin/env bun

import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  generatorDescriptorSchema,
  generationRequestSchema,
  generationResponseSchema,
} from "../src/contracts.ts";
import { writeJsonAtomic } from "../src/core/files.ts";

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

if (process.argv[2] === "describe" && process.argv[3] === "--json") {
  const descriptor = generatorDescriptorSchema.parse({
    protocol_version: "1",
    kind: "generator",
    id: "deterministic-mock",
    version: "1",
    revision: "source-tree",
    runtime: {
      name: "bun",
      version: Bun.version,
      revision: Bun.revision,
    },
    capabilities: {
      targets: ["artemis-java-maven"],
      seed: "deterministic",
      failed_artifact_capture: "complete",
      cancellation: true,
    },
  });
  process.stdout.write(`${JSON.stringify(descriptor)}\n`);
  process.exit(0);
}

if (process.argv[2] !== "generate") {
  throw new Error("usage: mock-generator.ts generate --request PATH --output DIRECTORY");
}

const request = generationRequestSchema.parse(await Bun.file(resolve(option("--request"))).json());
const outputDirectory = resolve(option("--output"));
if (request.output_dir !== outputDirectory) {
  throw new Error("request output_dir does not match --output");
}
const delay = request.parameters.delay_ms;
if (typeof delay === "number" && Number.isFinite(delay) && delay > 0) {
  await Bun.sleep(delay);
}

const artifactsDirectory = join(outputDirectory, "artifacts");
const template = join(artifactsDirectory, "template");
const solution = join(artifactsDirectory, "solution");
const tests = join(artifactsDirectory, "tests");
await Promise.all([
  mkdir(template, { recursive: true }),
  mkdir(solution, { recursive: true }),
  mkdir(tests, { recursive: true }),
]);

await Promise.all([
  writeFile(
    join(artifactsDirectory, "problem-statement.md"),
    `# ${request.case.title}\n\n${request.case.brief.trim()}\n`,
  ),
  writeFile(
    join(template, "Exercise.java"),
    "public final class Exercise { public static int answer() { return 0; } }\n",
  ),
  writeFile(
    join(solution, "Exercise.java"),
    "public final class Exercise { public static int answer() { return 42; } }\n",
  ),
  writeFile(join(tests, "ExerciseTest.java"), "final class ExerciseTest {}\n"),
]);

const response = generationResponseSchema.parse({
  protocol_version: "1",
  status: "succeeded",
  capture: {
    completeness: "complete",
  },
  artifacts: [
    {
      role: "problem_statement",
      path: "artifacts/problem-statement.md",
      media_type: "text/markdown",
    },
    { role: "template", path: "artifacts/template" },
    { role: "solution", path: "artifacts/solution" },
    { role: "tests", path: "artifacts/tests" },
  ],
  model: {
    provider: "fixture",
    id: "deterministic-mock",
    version: "1",
  },
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  },
});
await writeJsonAtomic(join(outputDirectory, "response.json"), response);
