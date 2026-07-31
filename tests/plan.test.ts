import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";

const fixture = resolve("examples/smoke/benchmark.yaml");

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
