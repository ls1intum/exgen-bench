import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { discoverTools, loadTool, runTier1Combination, runTool } from "../tools/kit/tool.ts";
import { loadBenchmark } from "../src/core/load.ts";
import { requireRunDirectory } from "../src/evaluation/process-run.ts";
import { createPlan } from "../src/core/plan.ts";
import { runPlan } from "../src/core/run.ts";
import { evaluationResponseSchema } from "../src/evaluation/contracts.ts";
import { processEvaluatorConfigSchema } from "../src/evaluation/process-config.ts";
import { metricCardsSchema } from "../src/export/metric-card.ts";
import { mergeMetricCards } from "../src/export/metric-card-merge.ts";

const FIXTURE_ORACLE = resolve("tools/tier1-deterministic/java-oracle/evaluator.fixture.yaml");

let directory: string;
let runDirectory: string;
let attempts: number;

// Parsed rather than loaded: loading resolves environment references such as an API key, and a
// manifest check must not depend on the credentials of whoever runs the tests.
async function readConfig(path: string) {
  return processEvaluatorConfigSchema.parse(parse(await readFile(path, "utf8")));
}

async function exgen(
  args: string[],
  entry = "src/cli.ts",
): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = Bun.spawn([process.execPath, "run", resolve(entry), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: process.env,
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { stdout, stderr, code };
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "exgen-tools-"));
  runDirectory = join(directory, "run");
  const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
  const plan = await createPlan(loaded);
  attempts = plan.attempts.length;
  await runPlan(loaded, plan, "tools", runDirectory, { create: true });
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("tool discovery", () => {
  test("finds the Tier 1 tools and the Tier 2 judge, in tier order", async () => {
    const tools = await discoverTools();
    expect(tools.map((tool) => [tool.manifest.tier, tool.manifest.id])).toEqual([
      [1, "tier1-deterministic"],
      [1, "tier1-model-assisted"],
      [1, "tier1-reference"],
      [2, "tier2-judge"],
    ]);
  });

  test("every listed evaluator configuration loads, and no evaluator belongs to two tools", async () => {
    const seen = new Map<string, string>();
    for (const tool of await discoverTools()) {
      for (const entry of tool.manifest.evaluators) {
        const config = await readConfig(join(tool.directory, entry.config));
        const owner = seen.get(config.evaluator.id);
        expect(owner === undefined || owner === tool.manifest.id).toBe(true);
        seen.set(config.evaluator.id, tool.manifest.id);
      }
    }
  });

  test("each tool publishes a metric card for every metric its evaluators request", async () => {
    for (const tool of await discoverTools()) {
      const cards = mergeMetricCards(
        await Promise.all(
          tool.metricCards.map(
            async (path) =>
              metricCardsSchema.parse(JSON.parse(await readFile(path, "utf8"))).metrics,
          ),
        ),
      );
      const documented = new Set(cards.map((card) => card.id));
      for (const entry of tool.manifest.evaluators) {
        const config = await readConfig(join(tool.directory, entry.config));
        expect(
          config.requested_metrics.filter((metric) => !documented.has(metric)),
          `${tool.manifest.id}/${entry.id}`,
        ).toEqual([]);
      }
    }
  });
});

describe("metric-card merging", () => {
  test("keeps a card shared by two files once and refuses a conflicting definition", async () => {
    const kit = metricCardsSchema.parse(
      JSON.parse(await readFile(resolve("tools/kit/metric-cards.json"), "utf8")),
    ).metrics;
    expect(mergeMetricCards([kit, kit])).toHaveLength(kit.length);
    const changed = kit.map((card) => ({ ...card, name: `${card.name} (changed)` }));
    expect(() => mergeMetricCards([kit, changed])).toThrow("defined differently");
  });
});

describe("running tools", () => {
  test("refuses a template configuration before anything runs", async () => {
    const tool = await loadTool(resolve("tools/tier1-model-assisted"));
    await expect(runTool(tool, { runDirectory })).rejects.toThrow("ships a template configuration");
  });

  test("refuses to combine a Tier 2 tool with Tier 1 tools", async () => {
    await expect(
      runTier1Combination({ runDirectory, tools: ["tier1-reference", "tier2-judge"] }),
    ).rejects.toThrow("cannot be combined");
  });

  test("refuses a configuration override for an evaluator that will not run", async () => {
    await expect(
      runTier1Combination({
        runDirectory,
        tools: ["tier1-reference"],
        configOverrides: new Map([["java-oracle", FIXTURE_ORACLE]]),
      }),
    ).rejects.toThrow("not selected");
  });

  test("runs one tool on its own through its own command line", async () => {
    const result = await exgen(
      ["evaluate", runDirectory, "--json"],
      "tools/tier1-reference/cli.ts",
    );
    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      evaluations: Array<{ evaluator: { id: string }; executed: number; resumed: number }>;
      release_arguments: string[];
    };
    expect(output.evaluations.map((entry) => entry.evaluator.id)).toEqual(["java-reference"]);
    const [reference] = output.evaluations;
    expect((reference?.executed ?? 0) + (reference?.resumed ?? 0)).toBe(attempts);
    expect(output.release_arguments).toContain(resolve("tools/tier1-reference/metric-cards.json"));
  }, 60_000);

  test("runs the Tier 2 judge skeleton on its own and measures nothing yet", async () => {
    const result = await exgen(["evaluate", runDirectory, "--json"], "tools/tier2-judge/cli.ts");
    expect(result.code, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as { evaluations: Array<{ journal: string }> };
    const journal = output.evaluations[0]?.journal;
    if (journal === undefined) throw new Error("the judge reported no evaluation");
    const responses = (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => evaluationResponseSchema.parse(JSON.parse(line)));
    expect(responses).toHaveLength(attempts);
    expect(
      responses.every((response) =>
        response.scores.every((score) => score.status === "not_applicable"),
      ),
    ).toBe(true);
  }, 60_000);

  test("combines Tier 1 tools in process, reporting each evaluator as it finishes", async () => {
    const reported: string[] = [];
    const result = await runTier1Combination({
      runDirectory,
      tools: ["tier1-reference", "tier1-deterministic"],
      configOverrides: new Map([["java-oracle", FIXTURE_ORACLE]]),
      onEvaluated: (summary) => reported.push(`${summary.tool}/${summary.evaluator.id}`),
    });
    expect(result.tools).toEqual(["tier1-reference", "tier1-deterministic"]);
    expect(reported).toEqual([
      "tier1-reference/java-reference",
      "tier1-deterministic/java-oracle",
      "tier1-deterministic/java-static",
      "tier1-deterministic/consistency",
      "tier1-deterministic/promise-traceability",
    ]);
    expect(result.evaluations.every((entry) => entry.tier === 1 && !entry.measured_nothing)).toBe(
      true,
    );
    expect(result.metricCards).toContain(resolve("tools/kit/metric-cards.json"));
    expect(result.evaluations.every((entry) => entry.executed + entry.resumed === attempts)).toBe(
      true,
    );
  }, 180_000);

  test("runs a tool's non-default evaluator when it is selected by name", async () => {
    const tool = await loadTool(resolve("tools/tier1-deterministic"));
    const [summary] = await runTool(tool, {
      runDirectory,
      evaluators: ["java-oracle-fixture"],
    });
    expect(summary?.evaluator.id).toBe("java-oracle");
    expect(summary?.config).toBe(FIXTURE_ORACLE);
    await expect(runTool(tool, { runDirectory, evaluators: ["missing"] })).rejects.toThrow(
      "has no evaluator missing",
    );
  }, 60_000);

  test("names a missing or foreign run directory before evaluating anything", async () => {
    await expect(requireRunDirectory(join(directory, "absent"))).rejects.toThrow(
      "run directory does not exist",
    );
    await expect(requireRunDirectory(directory)).rejects.toThrow("not an exgen run directory");
    await expect(requireRunDirectory(resolve("package.json"))).rejects.toThrow("not a directory");
  });

  test("combines Tier 1 tools over one run and publishes them as one release", async () => {
    const combined = await exgen([
      "evaluate",
      "tier1",
      runDirectory,
      "--tool",
      "tier1-deterministic",
      "--tool",
      "tier1-reference",
      "--config",
      `java-oracle=${FIXTURE_ORACLE}`,
      "--json",
    ]);
    expect(combined.code, combined.stderr).toBe(0);
    const output = JSON.parse(combined.stdout) as {
      tools: string[];
      evaluations: Array<{ tool: string; evaluator: { id: string } }>;
      release_arguments: string[];
    };
    expect(output.tools).toEqual(["tier1-deterministic", "tier1-reference"]);
    expect(output.evaluations.map((entry) => entry.evaluator.id)).toEqual([
      "java-oracle",
      "java-static",
      "consistency",
      "promise-traceability",
      "java-reference",
    ]);

    const releaseDirectory = join(directory, "release");
    const released = await exgen([
      "release",
      "create",
      runDirectory,
      "--output",
      releaseDirectory,
      "--metadata",
      resolve("examples/smoke/release.json"),
      ...output.release_arguments,
      "--authoritative-evaluator",
      "java-oracle",
      "--json",
    ]);
    expect(released.code, released.stderr).toBe(0);
    const manifest = JSON.parse(
      await readFile(join(releaseDirectory, "release-manifest.json"), "utf8"),
    ) as { evaluators: Array<{ id: string }> };
    expect(manifest.evaluators.map((entry) => entry.id).sort()).toEqual(
      [
        "consistency",
        "java-oracle",
        "java-reference",
        "java-static",
        "promise-traceability",
      ].sort(),
    );
  }, 180_000);
});
