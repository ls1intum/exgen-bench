import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { type DatasetCase, generationRequestSchema } from "../src/contracts.ts";
import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";

const benchmarkPath = resolve(
  import.meta.dir,
  "../studies/hyperion-development/benchmark.smoke.yaml",
);

function tally(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function extensionValues(cases: readonly DatasetCase[], key: string): string[] {
  return cases.map((item) => String(item.extensions?.[key]));
}

describe("Hyperion development corpus", () => {
  test("matches the composition table published in its README", async () => {
    const loaded = await loadBenchmark(benchmarkPath);

    expect(loaded.dataset.cases).toHaveLength(19);
    expect(tally(extensionValues(loaded.dataset.cases, "difficulty"))).toEqual({
      introductory: 4,
      intermediate: 12,
      advanced: 3,
    });
    expect(tally(extensionValues(loaded.dataset.cases, "statefulness"))).toEqual({
      stateless: 13,
      stateful: 6,
    });
    expect(tally(extensionValues(loaded.dataset.cases, "brief_specificity"))).toEqual({
      terse: 9,
      specified: 10,
    });

    const concepts = extensionValues(loaded.dataset.cases, "primary_concept");
    expect(new Set(concepts).size).toBe(18);
    expect(concepts.filter((concept) => concept === "state-machine")).toHaveLength(2);
  });

  test("records provenance that survives the upstream branch disappearing", async () => {
    const loaded = await loadBenchmark(benchmarkPath);

    const scenarioIds = extensionValues(loaded.dataset.cases, "source_scenario_id");
    expect(new Set(scenarioIds).size).toBe(19);
    expect(new Set(loaded.dataset.cases.map((item) => item.origin.citation)).size).toBe(19);

    for (const datasetCase of loaded.dataset.cases) {
      expect(datasetCase.origin.kind).toBe("collected");
      expect(datasetCase.origin.first_public_at).toBe(datasetCase.origin.created_at);
      const scenarioId = String(datasetCase.extensions?.source_scenario_id);
      expect(datasetCase.origin.citation).toContain(scenarioId);
      const commit = datasetCase.origin.citation?.match(/commit ([0-9a-f]{10})/)?.[1];
      expect(commit).toBeDefined();
      expect(datasetCase.origin.source_uri).toContain(`/blob/${commit}`);
    }

    const byDate = tally(loaded.dataset.cases.map((item) => item.origin.first_public_at ?? ""));
    expect(byDate).toEqual({ "2026-07-22": 4, "2026-07-25": 9, "2026-07-26": 6 });
  });

  test("separates the terse and specified brief instruments by length", async () => {
    const loaded = await loadBenchmark(benchmarkPath);
    const sized = await Promise.all(
      loaded.dataset.cases.map(async (datasetCase) => ({
        specificity: String(datasetCase.extensions?.brief_specificity),
        length: (await readFile(join(loaded.datasetDirectory, datasetCase.brief), "utf8")).trimEnd()
          .length,
      })),
    );
    const lengths = (specificity: string) =>
      sized.filter((item) => item.specificity === specificity).map((item) => item.length);

    expect(Math.max(...lengths("terse"))).toBeLessThan(Math.min(...lengths("specified")));
  });

  test("never exposes analysis extensions to a generation system", async () => {
    const loaded = await loadBenchmark(benchmarkPath);
    const plan = await createPlan(loaded);

    expect(plan.cases).toHaveLength(19);
    expect(plan.attempts).toHaveLength(19);
    expect(loaded.dataset.extensions).toMatchObject({
      intended_use: "development_regression",
      inference_allowed: false,
    });
    expect(plan.cases.every((item) => !("extensions" in item))).toBeTrue();

    const planned = plan.cases[0];
    if (!planned) throw new Error("plan has no cases");
    const requestCase = {
      id: planned.id,
      title: planned.title,
      brief: planned.brief,
      tags: planned.tags,
    };
    const request = {
      protocol_version: "2",
      attempt: { id: "obs-1", replicate: 1, seed: 1 },
      case: requestCase,
      target: plan.target,
      budget: plan.budget,
      parameters: {},
      output_dir: "/work/output",
    };

    expect(generationRequestSchema.safeParse(request).success).toBeTrue();
    expect(
      generationRequestSchema.safeParse({
        ...request,
        case: { ...requestCase, extensions: { difficulty: "advanced" } },
      }).success,
    ).toBeFalse();
  });
});
