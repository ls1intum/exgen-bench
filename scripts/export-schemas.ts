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
import { processEvaluatorConfigSchema } from "../src/evaluation/process-config.ts";
import { metricCardsSchema } from "../src/export/metric-card.ts";
import {
  publicAttemptSchema,
  publicCatalogSchema,
  publicReleaseSchema,
} from "../site/contracts.ts";
import { exercisePackageSchema } from "../src/data/exercise-package.ts";

const outputDirectory = resolve("schemas/protocol");
const schemaBaseUrl =
  "https://raw.githubusercontent.com/ls1intum/exgen-bench/main/schemas/protocol";
await mkdir(outputDirectory, { recursive: true });

// Input schemas preserve optional defaults; output schemas expose resolved fields as required.
type Authorship = "input" | "output";

const schemas: readonly (readonly [string, z.ZodType, Authorship])[] = [
  ["benchmark-config", benchmarkConfigSchema, "input"],
  ["dataset", datasetSchema, "input"],
  ["exercise-package", exercisePackageSchema, "input"],
  ["generator-descriptor", generatorDescriptorSchema, "input"],
  ["generation-request", generationRequestSchema, "output"],
  ["generation-response", generationResponseSchema, "input"],
  ["evaluator-identity", evaluatorIdentitySchema, "input"],
  ["evaluation-suite", evaluationSuiteSchema, "input"],
  ["evaluation-request", evaluationRequestSchema, "output"],
  ["evaluation-response", evaluationResponseSchema, "input"],
  ["process-evaluator-config", processEvaluatorConfigSchema, "input"],
  ["metric-cards", metricCardsSchema, "input"],
  ["public-attempt", publicAttemptSchema, "output"],
  ["public-catalog", publicCatalogSchema, "output"],
  ["public-release", publicReleaseSchema, "output"],
];

for (const [name, schema, io] of schemas) {
  const document: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `${schemaBaseUrl}/${name}.schema.json`,
    ...z.toJSONSchema(schema, { target: "draft-2020-12", io }),
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
