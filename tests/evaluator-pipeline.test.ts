import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";
import { runPlan } from "../src/core/run.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const EVALUATORS = ["java-oracle", "java-static", "java-reference", "consistency"] as const;

/**
 * java-oracle builds and grades the candidates, which this pipeline test has no deployment to do,
 * so it runs the named fixture profile that replays recorded build results. That profile measures
 * nothing, and this test asserts nothing about measurement: it covers multi-evaluator aggregation,
 * release export, and the single-authoritative-evaluator rule. Its published `evaluator.yaml` names
 * a deployment backend and is deliberately not exercised here.
 */
const EVALUATOR_CONFIGURATIONS: Record<(typeof EVALUATORS)[number], string> = {
  "java-oracle": "evaluators/java-oracle/evaluator.fixture.yaml",
  "java-static": "evaluators/java-static/evaluator.yaml",
  "java-reference": "evaluators/java-reference/evaluator.yaml",
  consistency: "evaluators/consistency/evaluator.yaml",
};

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

describe("the Phase 1 evaluator pipeline end to end", () => {
  test("four evaluators over one run export, verify and keep the primary estimand single-valued", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-evaluator-pipeline-"));
    temporaryDirectories.push(directory);
    const runDirectory = join(directory, "run");
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "evaluator-pipeline", runDirectory, { create: true });

    const journals: string[] = [];
    for (const evaluatorId of EVALUATORS) {
      const journalPath = join(directory, `${evaluatorId}.jsonl`);
      journals.push(journalPath);
      const result = await exgen([
        "evaluate",
        "process",
        runDirectory,
        "--config",
        resolve(EVALUATOR_CONFIGURATIONS[evaluatorId]),
        "--journal",
        journalPath,
        "--json",
      ]);
      expect(result.code, `${evaluatorId}: ${result.stderr}`).toBe(0);
      const summary = JSON.parse(result.stdout) as {
        evaluator: { id: string };
        executed: number;
        infrastructure_failures: number;
      };
      expect(summary.evaluator.id).toBe(evaluatorId);
      expect(summary.executed).toBe(plan.attempts.length);
      expect(summary.infrastructure_failures).toBe(0);
    }

    // Without a declaration the release must refuse to guess which evaluator is authoritative.
    const undeclared = await exgen([
      "release",
      "create",
      runDirectory,
      "--output",
      join(directory, "undeclared"),
      "--metadata",
      resolve("examples/smoke/release.json"),
      "--metric-cards",
      resolve("evaluators/metric-cards.json"),
      ...journals.flatMap((path) => ["--journal", path]),
    ]);
    expect(undeclared.code).toBe(1);
    expect(undeclared.stderr).toContain("must declare which one is authoritative");

    const releaseDirectory = join(directory, "release");
    const created = await exgen([
      "release",
      "create",
      runDirectory,
      "--output",
      releaseDirectory,
      "--metadata",
      resolve("examples/smoke/release.json"),
      "--metric-cards",
      resolve("evaluators/metric-cards.json"),
      ...journals.flatMap((path) => ["--journal", path]),
      "--authoritative-evaluator",
      "java-oracle",
      "--json",
    ]);
    expect(created.code, created.stderr).toBe(0);

    const manifest = JSON.parse(
      await readFile(join(releaseDirectory, "release-manifest.json"), "utf8"),
    ) as {
      authoritative_evaluator_id: string;
      evaluators: Array<{ id: string }>;
      counts: { evaluated: number; evaluation_records: number };
    };
    expect(manifest.authoritative_evaluator_id).toBe("java-oracle");
    expect(manifest.evaluators.map((entry) => entry.id).sort()).toEqual([...EVALUATORS].sort());
    expect(manifest.counts.evaluated).toBe(plan.attempts.length);
    expect(manifest.counts.evaluation_records).toBe(plan.attempts.length * EVALUATORS.length);

    const summary = JSON.parse(
      await readFile(join(releaseDirectory, "analysis/summary.json"), "utf8"),
    ) as {
      authoritative_evaluator_id: string;
      denominators: { evaluated: number; evaluation_records: number; quality_outcomes: number };
      evaluators: Array<{
        evaluator_id: string;
        authoritative: boolean;
        strict_successes: number;
      }>;
    };
    expect(summary.authoritative_evaluator_id).toBe("java-oracle");
    expect(summary.evaluators.filter((entry) => entry.authoritative)).toHaveLength(1);
    // Each evaluator reaches its own verdict over the same immutable candidates, and only the
    // authoritative one feeds the primary estimand.
    expect(
      summary.evaluators.find((entry) => entry.evaluator_id === "java-oracle")?.strict_successes,
    ).toBe(plan.attempts.length);
    expect(summary.denominators.quality_outcomes).toBe(plan.attempts.length);

    const index = (await readFile(join(releaseDirectory, "data/evaluation-index.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { evaluator_id: string; authoritative: boolean });
    expect(index).toHaveLength(plan.attempts.length * EVALUATORS.length);
    expect(new Set(index.map((row) => row.evaluator_id))).toEqual(new Set(EVALUATORS));
    expect(index.filter((row) => row.authoritative)).toHaveLength(plan.attempts.length);

    const scores = (await readFile(join(releaseDirectory, "data/scores.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as { evaluator_id: string; metric_id: string; score_status: string },
      );
    // A metric is attributable to the evaluator that produced it, not just to the attempt.
    expect(new Set(scores.map((row) => row.evaluator_id))).toEqual(new Set(EVALUATORS));

    // Under decision D2 every reference metric is not_applicable until the golden set arrives, and
    // the export has to carry that status through rather than dropping the row or scoring a zero.
    const referenceScores = scores.filter((row) => row.metric_id.startsWith("reference."));
    expect(referenceScores).toHaveLength(plan.attempts.length * 5);
    expect(referenceScores.every((row) => row.score_status === "not_applicable")).toBe(true);
    expect(
      scores
        .filter((row) => row.metric_id === "mutation.score")
        .every((row) => row.score_status === "not_applicable"),
    ).toBe(true);
    // The oracle's own scores are available for the same attempts, so "not applicable" is a
    // property of the metric here and not a symptom of a broken evaluation.
    expect(
      scores
        .filter((row) => row.metric_id === "oracle.solution_pass_rate")
        .every((row) => row.score_status === "ok"),
    ).toBe(true);

    const verified = await exgen(["release", "verify", releaseDirectory, "--json"]);
    expect(verified.code, verified.stderr).toBe(0);
    expect((JSON.parse(verified.stdout) as { files: number }).files).toBeGreaterThan(10);

    const site = await exgen([
      "site",
      "build",
      releaseDirectory,
      "--output",
      join(directory, "site"),
      "--json",
    ]);
    expect(site.code, site.stderr).toBe(0);
  }, 120_000);
});
