import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parse } from "yaml";

import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";
import { runPlan } from "../src/core/run.ts";
import { evaluationResponseSchema } from "../src/evaluation/contracts.ts";
import { processEvaluatorConfigSchema } from "../src/evaluation/process-config.ts";
import { discoverTools, planTier1, planTool, runToolPlan } from "../src/evaluation/tools.ts";
import { readMetricCards } from "../src/export/metric-card.ts";

const FIXTURE_ORACLE = resolve("tools/tier1-deterministic/java-oracle/evaluator.fixture.yaml");

let directory: string;
let runDirectory: string;
let attempts: number;

// Parsed rather than loaded: loading resolves environment references such as an API key, and a
// manifest check must not depend on the credentials of whoever runs the tests.
async function readConfig(path: string) {
  return processEvaluatorConfigSchema.parse(parse(await readFile(path, "utf8")));
}

async function exgen(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const child = Bun.spawn([process.execPath, "run", resolve("src/cli.ts"), ...args], {
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

describe("tool manifests", () => {
  test("no evaluator belongs to two tools", async () => {
    const owners = new Map<string, string>();
    for (const tool of await discoverTools()) {
      for (const entry of tool.manifest.evaluators) {
        const { evaluator } = await readConfig(join(tool.directory, entry.config));
        expect(owners.get(evaluator.id) ?? tool.manifest.id, evaluator.id).toBe(tool.manifest.id);
        owners.set(evaluator.id, tool.manifest.id);
      }
    }
  });

  test("each tool publishes a metric card for every metric its evaluators request", async () => {
    for (const tool of await discoverTools()) {
      const documented = new Set((await readMetricCards(tool.metricCards)).map((card) => card.id));
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

describe("tool discovery", () => {
  async function toolsWith(manifests: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(directory, "tools-"));
    for (const [name, manifest] of Object.entries(manifests)) {
      await mkdir(join(root, name));
      await writeFile(join(root, name, "tool.yaml"), manifest);
    }
    return root;
  }

  const manifest = (id: string, evaluator: string) =>
    `schema_version: "1"\nid: ${id}\ntier: 1\ntitle: T\ndescription: D\n` +
    `evaluators:\n  - id: ${evaluator}\n    config: e.yaml\n    description: D\n`;

  test("refuse a tool whose ID is not its directory name", async () => {
    const root = await toolsWith({ "tier1-a": manifest("tier1-b", "one") });
    await expect(discoverTools(root)).rejects.toThrow("it must be tier1-a");
  });

  test("refuse an evaluator ID listed by two tools", async () => {
    const root = await toolsWith({
      "tier1-a": manifest("tier1-a", "shared"),
      "tier1-b": manifest("tier1-b", "shared"),
    });
    await expect(discoverTools(root)).rejects.toThrow("listed by both tier1-a and tier1-b");
  });
});

describe("metric-card files", () => {
  const kit = resolve("tools/kit/metric-cards.json");

  test("keep a card that two files share once", async () => {
    expect(await readMetricCards([kit, kit])).toEqual(await readMetricCards([kit]));
  });

  test("refuse two different definitions of one card identity", async () => {
    const cards = await readMetricCards([kit]);
    const changed = join(directory, "changed-cards.json");
    await writeFile(
      changed,
      JSON.stringify({
        schema_version: "1",
        metrics: cards.map((card) => ({ ...card, name: `${card.name} (changed)` })),
      }),
    );
    await expect(readMetricCards([kit, changed])).rejects.toThrow("defined differently");
  });
});

describe("tool plans", () => {
  test("refuse a template configuration that was not replaced", async () => {
    await expect(planTool("tier1-model-assisted")).rejects.toThrow(
      "ships a template configuration",
    );
  });

  test("skip a template tool in an implicit Tier 1 combination until it is configured", async () => {
    const implicit = await planTier1();
    expect(implicit.tools).toEqual(["tier1-deterministic", "tier1-reference"]);
    expect(implicit.skipped).toEqual(["tier1-model-assisted"]);

    const configured = await planTier1(
      [],
      new Map([["promise-traceability-model", join(directory, "my-model.yaml")]]),
    );
    expect(configured.tools).toContain("tier1-model-assisted");
    expect(configured.skipped).toEqual([]);
  });

  test("refuse to combine a Tier 2 tool", async () => {
    await expect(planTier1(["tier2-judge"])).rejects.toThrow("cannot be combined");
  });

  test("refuse a configuration override for an evaluator that will not run", async () => {
    await expect(
      planTier1(["tier1-reference"], new Map([["java-oracle", FIXTURE_ORACLE]])),
    ).rejects.toThrow("not selected");
  });

  test("select a non-default evaluator by name", async () => {
    const plan = await planTool("tier1-deterministic", ["java-oracle-fixture"]);
    expect(plan.evaluations.map((entry) => entry.config)).toEqual([FIXTURE_ORACLE]);
  });

  test("refuse an evaluator named twice", async () => {
    await expect(
      planTool("tier1-deterministic", ["java-oracle-fixture", "java-oracle-fixture"]),
    ).rejects.toThrow("only once");
  });

  test("refuse an evaluator the tool does not list", async () => {
    await expect(planTool("tier1-deterministic", ["missing"])).rejects.toThrow(
      "has no evaluator missing",
    );
  });
});

describe("tool runs", () => {
  test("run the Tier 2 judge skeleton on its own, reporting every metric not applicable", async () => {
    const [summary] = await runToolPlan(await planTool("tier2-judge"), {
      runDirectory,
      retryInfrastructure: false,
    });
    expect(summary).toMatchObject({ tool: "tier2-judge", tier: 2, measured_nothing: false });
    const journal = summary?.journal;
    if (journal === undefined) throw new Error("the judge reported no evaluation");
    const responses = (await readFile(journal, "utf8"))
      .trim()
      .split("\n")
      .map((line) => evaluationResponseSchema.parse(JSON.parse(line)));
    expect(responses).toHaveLength(attempts);
    // Without a gate, an answer records only that the judge answered.
    expect(responses.every((response) => response.strict_success === true)).toBe(true);
    const statuses = responses.flatMap((response) => response.scores.map((score) => score.status));
    expect(new Set(statuses)).toEqual(new Set(["not_applicable"]));
  }, 60_000);

  test("load every configuration before the first evaluator starts", async () => {
    const evaluations = join(runDirectory, "evaluations");
    await mkdir(evaluations, { recursive: true });
    const before = await readdir(evaluations);
    const plan = await planTier1(
      ["tier1-deterministic", "tier1-reference"],
      new Map([
        ["java-oracle", FIXTURE_ORACLE],
        ["java-reference", join(directory, "missing.yaml")],
      ]),
    );
    await expect(runToolPlan(plan, { runDirectory, retryInfrastructure: false })).rejects.toThrow(
      "tier1-reference/java-reference:",
    );
    expect(await readdir(evaluations)).toEqual(before);
  });

  test("refuse a --config that configures a different evaluator", async () => {
    const plan = await planTool(
      "tier1-reference",
      [],
      new Map([
        ["java-reference", resolve("tools/tier1-deterministic/java-static/evaluator.yaml")],
      ]),
    );
    await expect(runToolPlan(plan, { runDirectory, retryInfrastructure: false })).rejects.toThrow(
      "configures evaluator java-static, not java-reference",
    );
  });

  test("reject a --config that is not <entry>=<path>", async () => {
    const result = await exgen([
      "evaluate",
      "tool",
      "tier1-reference",
      runDirectory,
      "--config",
      "java-reference",
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("expected <entry>=<config-path>");
  });

  test("combine Tier 1 tools over one run and publish them as one release", async () => {
    const combined = await exgen([
      "evaluate",
      "tier1",
      runDirectory,
      "--config",
      `java-oracle=${FIXTURE_ORACLE}`,
      "--json",
    ]);
    expect(combined.code, combined.stderr).toBe(0);
    expect(combined.stderr).toContain("skipped tier1-model-assisted");
    const output = JSON.parse(combined.stdout) as {
      evaluations: Array<{ tool: string; evaluator: { id: string }; executed: number }>;
      release_arguments: string[];
    };
    expect(output.evaluations.map((entry) => `${entry.tool}/${entry.evaluator.id}`)).toEqual([
      "tier1-deterministic/java-oracle",
      "tier1-deterministic/java-static",
      "tier1-deterministic/consistency",
      "tier1-deterministic/promise-traceability",
      "tier1-deterministic/item-writing-flaws",
      "tier1-reference/java-reference",
    ]);
    expect(output.evaluations.every((entry) => entry.executed === attempts)).toBe(true);

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
    expect(manifest.evaluators.map((entry) => entry.id).sort()).toEqual([
      "consistency",
      "item-writing-flaws",
      "java-oracle",
      "java-reference",
      "java-static",
      "promise-traceability",
    ]);
  }, 180_000);
});
