import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { System } from "../contracts.ts";
import { digestJson, sha256 } from "./canonical.ts";
import type { LoadedBenchmark } from "./load.ts";

export interface PlannedCase {
  id: string;
  title: string;
  tags: string[];
  brief: string;
  digest: string;
  origin: LoadedBenchmark["dataset"]["cases"][number]["origin"];
  authors: LoadedBenchmark["dataset"]["cases"][number]["authors"];
  license: string;
  exposure: LoadedBenchmark["dataset"]["cases"][number]["exposure"];
}

export interface PlannedAttempt {
  ordinal: number;
  id: string;
  generationKey: string;
  caseId: string;
  systemId: string;
  replicate: number;
  seed: number;
}

export interface ExperimentPlan {
  schema_version: "1";
  id: string;
  benchmark: {
    id: string;
    title: string;
  };
  dataset: {
    id: string;
    version: string;
    digest: string;
  };
  target: LoadedBenchmark["config"]["target"];
  budget: LoadedBenchmark["config"]["budget"];
  systems: System[];
  trials: LoadedBenchmark["config"]["trials"];
  analysis: LoadedBenchmark["config"]["analysis"];
  schedule: {
    method: "randomized_complete_blocks";
    seed: string;
  };
  execution: LoadedBenchmark["config"]["execution"];
  extensions: LoadedBenchmark["config"]["extensions"];
  cases: PlannedCase[];
  attempts: PlannedAttempt[];
}

function pairedSeed(baseSeed: number, caseId: string, replicate: number): number {
  const digest = sha256(`${baseSeed}\0${caseId}\0${replicate}`);
  return Number.parseInt(digest.slice(0, 8), 16) >>> 0;
}

function deterministicShuffle<T>(values: T[], seedHex: string): T[] {
  let state = Number.parseInt(seedHex.slice(0, 8), 16) >>> 0;
  const random = (): number => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };

  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = shuffled[index];
    const swap = shuffled[swapIndex];
    if (current === undefined || swap === undefined) {
      throw new Error("shuffle index is out of bounds");
    }
    shuffled[index] = swap;
    shuffled[swapIndex] = current;
  }
  return shuffled;
}

function safeName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

async function resolveBrief(datasetDirectory: string, brief: string): Promise<string> {
  if (isAbsolute(brief)) {
    throw new Error(`dataset brief paths must be relative: ${brief}`);
  }
  const path = resolve(datasetDirectory, brief);
  const relativePath = relative(datasetDirectory, path);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`dataset brief escapes its dataset directory: ${brief}`);
  }
  let current = datasetDirectory;
  for (const component of relativePath.split(sep).filter(Boolean)) {
    current = join(current, component);
    if ((await lstat(current)).isSymbolicLink()) {
      throw new Error(`dataset brief paths must not contain symbolic links: ${brief}`);
    }
  }
  return path;
}

export async function createPlan(loaded: LoadedBenchmark): Promise<ExperimentPlan> {
  const cases: PlannedCase[] = await Promise.all(
    loaded.dataset.cases.map(async (datasetCase) => {
      const briefPath = await resolveBrief(loaded.datasetDirectory, datasetCase.brief);
      const brief = await readFile(briefPath, "utf8");
      return {
        id: datasetCase.id,
        title: datasetCase.title,
        tags: datasetCase.tags,
        brief,
        origin: datasetCase.origin,
        authors: datasetCase.authors,
        license: datasetCase.license,
        exposure: datasetCase.exposure,
        digest: digestJson({
          id: datasetCase.id,
          title: datasetCase.title,
          tags: datasetCase.tags,
          brief,
          origin: datasetCase.origin,
          authors: datasetCase.authors,
          license: datasetCase.license,
          exposure: datasetCase.exposure,
          extensions: datasetCase.extensions,
        }),
      };
    }),
  );

  const datasetDigest = digestJson({
    id: loaded.dataset.id,
    version: loaded.dataset.version,
    license: loaded.dataset.license,
    cases,
    extensions: loaded.dataset.extensions,
  });

  const systemsGenerationIdentity = loaded.config.systems.map((system) => ({
    id: system.id,
    version: system.version,
    revision: system.revision,
    runtime: system.runtime,
    parameters: system.parameters,
  }));
  const scheduleSeed = digestJson({
    dataset: datasetDigest,
    systems: systemsGenerationIdentity.map(({ id, version, revision }) => ({
      id,
      version,
      revision,
    })),
    trials: loaded.config.trials,
    analysis: loaded.config.analysis,
  });
  const schedule = {
    method: "randomized_complete_blocks" as const,
    seed: scheduleSeed,
  };
  const planIdentity = {
    benchmark: { id: loaded.config.id },
    dataset: {
      id: loaded.dataset.id,
      version: loaded.dataset.version,
      digest: datasetDigest,
    },
    target: loaded.config.target,
    budget: loaded.config.budget,
    systems: loaded.config.systems.map((system) => ({
      ...systemsGenerationIdentity.find((candidate) => candidate.id === system.id),
      factors: system.factors,
    })),
    trials: loaded.config.trials,
    analysis: loaded.config.analysis,
    schedule,
    execution: {
      concurrency: loaded.config.execution.concurrency,
      max_log_bytes: loaded.config.execution.max_log_bytes,
    },
  };
  const planId = digestJson(planIdentity);

  const attemptBlocks = cases.flatMap((datasetCase) =>
    Array.from(
      { length: loaded.config.trials.replicates },
      (_, replicateIndex) => replicateIndex + 1,
    ).map((replicate) => {
      const seed = pairedSeed(loaded.config.trials.base_seed, datasetCase.id, replicate);
      return loaded.config.systems.map((system) => {
        const generationKey = digestJson({
          benchmark: loaded.config.id,
          dataset: { id: loaded.dataset.id, version: loaded.dataset.version },
          case: { id: datasetCase.id, digest: datasetCase.digest },
          system: systemsGenerationIdentity.find((candidate) => candidate.id === system.id),
          target: loaded.config.target,
          budget: loaded.config.budget,
          replicate,
          seed,
        });
        return {
          ordinal: 0,
          id: `${safeName(datasetCase.id)}--${safeName(system.id)}--r${replicate
            .toString()
            .padStart(3, "0")}--${generationKey.slice(0, 12)}`,
          generationKey,
          caseId: datasetCase.id,
          systemId: system.id,
          replicate,
          seed,
        };
      });
    }),
  );

  const scheduledAttempts = deterministicShuffle(attemptBlocks, scheduleSeed)
    .flatMap((block) =>
      deterministicShuffle(
        block,
        digestJson({
          scheduleSeed,
          caseId: block[0]?.caseId,
          replicate: block[0]?.replicate,
        }),
      ),
    )
    .map((attempt, index) => ({
      ...attempt,
      ordinal: index + 1,
    }));

  return {
    schema_version: "1",
    id: planId,
    benchmark: { id: loaded.config.id, title: loaded.config.title },
    dataset: planIdentity.dataset,
    target: loaded.config.target,
    budget: loaded.config.budget,
    systems: loaded.config.systems,
    trials: loaded.config.trials,
    analysis: loaded.config.analysis,
    schedule,
    execution: loaded.config.execution,
    extensions: loaded.config.extensions,
    cases,
    attempts: scheduledAttempts,
  };
}
