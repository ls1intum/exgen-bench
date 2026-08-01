import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";

const fixture = resolve("examples/smoke/benchmark.yaml");
const temporaryDirectories: string[] = [];

async function benchmarkWith(overrides: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exgen-analysis-"));
  temporaryDirectories.push(directory);
  const base = parse(await readFile(fixture, "utf8")) as Record<string, unknown>;
  const path = join(directory, "benchmark.json");
  await writeFile(
    path,
    JSON.stringify({ ...base, dataset: resolve("examples/smoke/dataset.yaml"), ...overrides }),
  );
  return path;
}

async function withSecondSystem(): Promise<Record<string, unknown>[]> {
  const base = parse(await readFile(fixture, "utf8")) as { systems: Record<string, unknown>[] };
  const first = base.systems[0];
  if (!first) {
    throw new Error("fixture has no system");
  }
  return [
    {
      ...first,
      factors: { ...(first.factors as object), model: { value: "a", control: "observed" } },
    },
    {
      ...structuredClone(first),
      id: "second-system",
      revision: "other-revision",
      factors: { ...(first.factors as object), model: { value: "b", control: "observed" } },
    },
  ];
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("experiment planning", () => {
  test("is deterministic", async () => {
    const loaded = await loadBenchmark(fixture);
    const first = await createPlan(loaded);
    const second = await createPlan(loaded);

    expect(first).toEqual(second);
    expect(first.attempts.map((attempt) => attempt.ordinal)).toEqual([1, 2]);
  });

  test("pairs seeds across systems but keeps generation identities distinct", async () => {
    const loaded = await loadBenchmark(fixture);
    const firstSystem = loaded.config.systems[0];
    if (!firstSystem) {
      throw new Error("fixture has no system");
    }
    loaded.config.systems.push({
      ...structuredClone(firstSystem),
      id: "second-system",
      name: "Second system",
      revision: "different-revision",
    });

    const plan = await createPlan(loaded);
    const byReplicate = Map.groupBy(plan.attempts, (attempt) => attempt.replicate);
    for (const attempts of byReplicate.values()) {
      expect(new Set(attempts.map((attempt) => attempt.seed)).size).toBe(1);
      expect(new Set(attempts.map((attempt) => attempt.generationKey)).size).toBe(2);
      expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(2);
    }
    expect(plan.schedule.method).toBe("randomized_complete_blocks");
    for (let index = 0; index < plan.attempts.length; index += 2) {
      const block = plan.attempts.slice(index, index + 2);
      expect(new Set(block.map((attempt) => `${attempt.caseId}\0${attempt.replicate}`)).size).toBe(
        1,
      );
      expect(new Set(block.map((attempt) => attempt.systemId)).size).toBe(2);
    }
  });

  test("invalidates identity when a system revision changes", async () => {
    const loaded = await loadBenchmark(fixture);
    const before = await createPlan(loaded);
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.revision = "new-revision";
    const after = await createPlan(loaded);

    expect(after.id).not.toBe(before.id);
    expect(after.attempts.map((attempt) => attempt.generationKey)).not.toEqual(
      before.attempts.map((attempt) => attempt.generationKey),
    );
  });

  test("does not make output location part of scientific identity", async () => {
    const loaded = await loadBenchmark(fixture);
    const before = await createPlan(loaded);
    loaded.config.execution.results_dir = "/another/results/location";
    const after = await createPlan(loaded);

    expect(after.id).toBe(before.id);
    expect(after.attempts).toEqual(before.attempts);
  });

  test("rejects briefs outside the dataset directory", async () => {
    const loaded = await loadBenchmark(fixture);
    const datasetCase = loaded.dataset.cases[0];
    if (!datasetCase) {
      throw new Error("fixture has no dataset case");
    }
    datasetCase.brief = "../mock-generator.ts";

    await expect(createPlan(loaded)).rejects.toThrow("escapes its dataset directory");
  });
});

describe("benchmark analysis coherence", () => {
  test("rejects a difference estimand that declares no contrast", async () => {
    const path = await benchmarkWith({
      analysis: {
        method: "case_clustered_bootstrap",
        estimand: "end_to_end_within_budget_strict_success_rate_difference",
        bootstrap_seed: 20260730,
        bootstrap_resamples: 500,
        confidence_level: 0.95,
        contrasts: [],
      },
    });

    await expect(loadBenchmark(path)).rejects.toThrow(
      "estimand end_to_end_within_budget_strict_success_rate_difference requires one declared contrast",
    );
  });

  test("rejects a single-arm estimand that declares a contrast", async () => {
    const path = await benchmarkWith({
      systems: await withSecondSystem(),
      analysis: {
        method: "case_clustered_bootstrap",
        estimand: "end_to_end_within_budget_strict_success_rate",
        bootstrap_seed: 20260730,
        bootstrap_resamples: 500,
        confidence_level: 0.95,
        contrasts: [{ system_a: "deterministic-mock", system_b: "second-system" }],
      },
    });

    await expect(loadBenchmark(path)).rejects.toThrow(
      "estimand end_to_end_within_budget_strict_success_rate is single-arm and must not declare a contrast",
    );
  });

  test("rejects the paired method with only one system to pair", async () => {
    const path = await benchmarkWith({
      analysis: {
        method: "case_clustered_paired_bootstrap",
        estimand: "end_to_end_within_budget_strict_success_rate",
        bootstrap_seed: 20260730,
        bootstrap_resamples: 500,
        confidence_level: 0.95,
        contrasts: [],
      },
    });

    await expect(loadBenchmark(path)).rejects.toThrow(
      "case_clustered_paired_bootstrap requires at least two systems to pair",
    );
  });

  test("accepts a coherent single-arm descriptive benchmark", async () => {
    const loaded = await loadBenchmark(fixture);

    expect(loaded.config.analysis.method).toBe("case_clustered_bootstrap");
    expect(loaded.config.analysis.estimand).toBe("end_to_end_within_budget_strict_success_rate");
    expect(loaded.config.analysis.contrasts).toEqual([]);
    expect(loaded.config.systems).toHaveLength(1);
  });

  test("accepts a coherent two-arm paired benchmark", async () => {
    const path = await benchmarkWith({
      systems: await withSecondSystem(),
      analysis: {
        method: "case_clustered_paired_bootstrap",
        estimand: "end_to_end_within_budget_strict_success_rate_difference",
        bootstrap_seed: 20260730,
        bootstrap_resamples: 500,
        confidence_level: 0.95,
        contrasts: [{ system_a: "deterministic-mock", system_b: "second-system" }],
        design: { smallest_meaningful_effect: 0.2 },
      },
    });

    const loaded = await loadBenchmark(path);

    expect(loaded.config.systems.map((system) => system.id)).toEqual([
      "deterministic-mock",
      "second-system",
    ]);
    expect(loaded.config.analysis.contrasts).toHaveLength(1);
  });
});

describe("treatment identity", () => {
  test("mints a new treatment identity when a factor changes", async () => {
    const loaded = await loadBenchmark(fixture);
    const before = await createPlan(loaded);
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.factors = { ...system.factors, model: { value: "other-model", control: "declared" } };
    const after = await createPlan(loaded);

    expect(after.id).not.toBe(before.id);
    expect(after.attempts.map((attempt) => attempt.generationKey)).not.toEqual(
      before.attempts.map((attempt) => attempt.generationKey),
    );
  });

  test("keeps the treatment identity when only adapter parameters change", async () => {
    const loaded = await loadBenchmark(fixture);
    const before = await createPlan(loaded);
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.parameters = { ...system.parameters, poll_interval_ms: 2000 };
    const after = await createPlan(loaded);

    expect(after.id).toBe(before.id);
    expect(after.attempts).toEqual(before.attempts);
  });

  test("rejects arms that differ only by an unverifiable label", async () => {
    const base = parse(await readFile(fixture, "utf8")) as { systems: Record<string, unknown>[] };
    const first = base.systems[0];
    if (!first) {
      throw new Error("fixture has no system");
    }
    const path = await benchmarkWith({
      systems: [
        first,
        { ...structuredClone(first), id: "second-system", factors: { approach: "other" } },
      ],
    });

    await expect(loadBenchmark(path)).rejects.toThrow(
      "a multi-arm benchmark needs a requested or observed factor whose value differs across arms",
    );
  });

  test("rejects a factor name that is also a fixed target parameter", async () => {
    const systems = await withSecondSystem();
    const path = await benchmarkWith({
      systems: systems.map((system) => ({
        ...system,
        factors: { ...(system.factors as Record<string, unknown>) },
      })),
      target: {
        id: "artemis-java-maven",
        version: "1",
        revision: "protocol-fixture-v1",
        parameters: { language: "java", build_system: "maven", model: "fixed" },
      },
    });

    await expect(loadBenchmark(path)).rejects.toThrow(
      "model is a fixed target parameter and cannot also vary across arms",
    );
  });

  test("folds a per-case target override into that case's identity only", async () => {
    const loaded = await loadBenchmark(fixture);
    const before = await createPlan(loaded);
    const datasetCase = loaded.dataset.cases[0];
    if (!datasetCase) {
      throw new Error("fixture has no case");
    }
    loaded.config.target.parameters.case_overrides = { [datasetCase.id]: { language: "kotlin" } };
    const after = await createPlan(loaded);

    expect(after.cases[0]?.targetParameters).toEqual({
      language: "kotlin",
      build_system: "maven",
    });
    expect(before.cases[0]?.targetParameters).toEqual({
      language: "java",
      build_system: "maven",
    });
    expect(after.attempts.map((attempt) => attempt.generationKey)).not.toEqual(
      before.attempts.map((attempt) => attempt.generationKey),
    );
  });

  test("rejects a target override for a case outside the dataset", async () => {
    const loaded = await loadBenchmark(fixture);
    loaded.config.target.parameters.case_overrides = { "not-a-case": { language: "kotlin" } };

    await expect(createPlan(loaded)).rejects.toThrow(
      "target parameter overrides reference cases outside the dataset: not-a-case",
    );
  });
});

describe("statistical conclusion validity", () => {
  async function comparativePlan(smallestMeaningfulEffect: number) {
    const path = await benchmarkWith({
      dataset: resolve("datasets/hyperion-development-v1/dataset.yaml"),
      systems: await withSecondSystem(),
      trials: { replicates: 1, base_seed: 20260730 },
      analysis: {
        method: "case_clustered_paired_bootstrap",
        estimand: "end_to_end_within_budget_strict_success_rate_difference",
        bootstrap_seed: 20260730,
        bootstrap_resamples: 500,
        confidence_level: 0.95,
        contrasts: [{ system_a: "deterministic-mock", system_b: "second-system" }],
        design: { smallest_meaningful_effect: smallestMeaningfulEffect },
      },
    });
    return createPlan(await loadBenchmark(path));
  }

  test("refuses a comparative design that cannot detect its own declared effect", async () => {
    await expect(comparativePlan(0.15)).rejects.toThrow(
      "this design cannot detect its declared smallest meaningful effect",
    );
  });

  test("records the minimum detectable effect and the cluster-inference limitation", async () => {
    const plan = await comparativePlan(0.35);

    expect(plan.analysis_design?.clusters).toBe(19);
    expect(plan.analysis_design?.minimum_detectable_effect).toBeCloseTo(0.321, 3);
    expect(plan.analysis_design?.distinguishing_factors).toEqual(["model"]);
    expect(plan.analysis_design?.coverage_limitation).toContain("under-covers");
    expect(plan.analysis_design?.references.join(" ")).toContain("Canay");
  });

  test("requires a comparative estimand to declare a smallest meaningful effect", async () => {
    const path = await benchmarkWith({
      systems: await withSecondSystem(),
      analysis: {
        method: "case_clustered_paired_bootstrap",
        estimand: "end_to_end_within_budget_strict_success_rate_difference",
        bootstrap_seed: 20260730,
        bootstrap_resamples: 500,
        confidence_level: 0.95,
        contrasts: [{ system_a: "deterministic-mock", system_b: "second-system" }],
      },
    });

    await expect(loadBenchmark(path)).rejects.toThrow(
      "requires analysis.design.smallest_meaningful_effect",
    );
  });
});
