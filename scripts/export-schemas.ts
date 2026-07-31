import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import {
  benchmarkConfigSchema,
  datasetSchema,
  generatorDescriptorSchema,
  generationRequestSchema,
  generationResponseSchema,
} from "../src/contracts.ts";
import {
  evaluationRequestSchema,
  evaluationResponseSchema,
  evaluationSuiteSchema,
  evaluatorIdentitySchema,
} from "../src/evaluation/contracts.ts";
import { metricCardsSchema } from "../src/export/metric-card.ts";
import {
  publicAttemptSchema,
  publicCatalogSchema,
  publicReleaseSchema,
} from "../site/contracts.ts";

const outputDirectory = resolve("schemas/protocol");
const schemaBaseUrl =
  "https://raw.githubusercontent.com/ls1intum/exgen-bench/main/schemas/protocol";
await mkdir(outputDirectory, { recursive: true });

const schemas = [
  ["benchmark-config", benchmarkConfigSchema],
  ["dataset", datasetSchema],
  ["generator-descriptor", generatorDescriptorSchema],
  ["generation-request", generationRequestSchema],
  ["generation-response", generationResponseSchema],
  ["evaluator-identity", evaluatorIdentitySchema],
  ["evaluation-suite", evaluationSuiteSchema],
  ["evaluation-request", evaluationRequestSchema],
  ["evaluation-response", evaluationResponseSchema],
  ["metric-cards", metricCardsSchema],
  ["public-attempt", publicAttemptSchema],
  ["public-catalog", publicCatalogSchema],
  ["public-release", publicReleaseSchema],
] as const;

for (const [name, schema] of schemas) {
  const document: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${schemaBaseUrl}/${name}.schema.json`,
    ...z.toJSONSchema(schema, { target: "draft-2020-12" }),
  };
  await writeFile(
    resolve(outputDirectory, `${name}.schema.json`),
    `${JSON.stringify(document, null, 2)}\n`,
    "utf8",
  );
}

const formatter = Bun.spawn(
  [resolve("node_modules/.bin/biome"), "format", "--write", outputDirectory],
  { stdout: "inherit", stderr: "inherit" },
);
if ((await formatter.exited) !== 0) {
  throw new Error("failed to format generated protocol schemas");
}
