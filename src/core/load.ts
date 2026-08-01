import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import {
  type BenchmarkConfig,
  benchmarkConfigSchema,
  type Dataset,
  datasetSchema,
} from "../contracts.ts";

async function readStructuredFile(path: string): Promise<unknown> {
  const source = await readFile(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(source) : parse(source);
}

function assertUnique(values: string[], label: string): void {
  const duplicates = values.filter((value, index) => values.indexOf(value) !== index);
  if (duplicates.length > 0) {
    throw new Error(`${label} IDs must be unique: ${[...new Set(duplicates)].join(", ")}`);
  }
}

function assertCoherentAnalysis(config: BenchmarkConfig): void {
  const { method, estimand, contrasts } = config.analysis;
  const comparative = estimand.endsWith("_difference");
  if (comparative && contrasts.length === 0) {
    throw new Error(`estimand ${estimand} requires one declared contrast`);
  }
  if (!comparative && contrasts.length > 0) {
    throw new Error(`estimand ${estimand} is single-arm and must not declare a contrast`);
  }
  if (method === "case_clustered_paired_bootstrap" && config.systems.length < 2) {
    throw new Error(`${method} requires at least two systems to pair`);
  }
  if (comparative && config.analysis.design === undefined) {
    throw new Error(
      `estimand ${estimand} requires analysis.design.smallest_meaningful_effect so the plan can check it is detectable`,
    );
  }
}

export interface LoadedBenchmark {
  config: BenchmarkConfig;
  configPath: string;
  configDirectory: string;
  dataset: Dataset;
  datasetPath: string;
  datasetDirectory: string;
}

export async function loadBenchmark(configPathInput: string): Promise<LoadedBenchmark> {
  const configPath = resolve(configPathInput);
  const config = benchmarkConfigSchema.parse(await readStructuredFile(configPath));
  const configDirectory = dirname(configPath);
  const datasetPath = resolve(configDirectory, config.dataset);
  const dataset = datasetSchema.parse(await readStructuredFile(datasetPath));

  assertUnique(
    config.systems.map((system) => system.id),
    "system",
  );
  assertUnique(
    dataset.cases.map((datasetCase) => datasetCase.id),
    "case",
  );
  assertCoherentAnalysis(config);

  return {
    config,
    configPath,
    configDirectory,
    dataset,
    datasetPath,
    datasetDirectory: dirname(datasetPath),
  };
}
