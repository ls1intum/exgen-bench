#!/usr/bin/env bun

/**
 * Deterministic demo generator for the expert-rating survey.
 *
 * It "generates" an exercise by copying the hand-written candidate committed under
 * `candidates/<case-id>/artifacts/`, so a run of the demo benchmark produces the same bytes every
 * time and needs no model, credentials or network.
 */

import { cp, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  GENERATION_PROTOCOL_VERSION,
  generationRequestSchema,
  generationResponseSchema,
  generatorDescriptorSchema,
} from "../../../src/contracts.ts";
import { writeJsonAtomic } from "../../../src/core/files.ts";

const CANDIDATES_DIRECTORY = join(import.meta.dir, "candidates");

function option(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`missing ${name}`);
  }
  return value;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

if (process.argv[2] === "describe" && process.argv[3] === "--json") {
  const descriptor = generatorDescriptorSchema.parse({
    protocol_version: GENERATION_PROTOCOL_VERSION,
    kind: "generator",
    id: "demo-generator",
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
  throw new Error("usage: generator.ts generate --request PATH --output DIRECTORY");
}

const request = generationRequestSchema.parse(await Bun.file(resolve(option("--request"))).json());
const outputDirectory = resolve(option("--output"));
if (request.output_dir !== outputDirectory) {
  throw new Error("request output_dir does not match --output");
}

const source = join(CANDIDATES_DIRECTORY, request.case.id, "artifacts");
if (!(await isDirectory(source))) {
  throw new Error(
    `demo-generator has no candidate for case "${request.case.id}"; expected ${source}`,
  );
}
await cp(source, join(outputDirectory, "artifacts"), { recursive: true });

const response = generationResponseSchema.parse({
  protocol_version: GENERATION_PROTOCOL_VERSION,
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
    id: "demo-generator",
    version: "1",
  },
  usage: {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  },
  cost: {
    amount: 0,
    currency: "USD",
  },
});
await writeJsonAtomic(join(outputDirectory, "response.json"), response);
