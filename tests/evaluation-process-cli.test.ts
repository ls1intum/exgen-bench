import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";
import { runPlan } from "../src/core/run.ts";
import { readEvaluationJournalHistory } from "../src/evaluation/runner.ts";

const temporaryDirectories: string[] = [];

function unexpectedStderr(stderr: string): string[] {
  return stderr
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !/deprecat|^\[bun]|^warning:/i.test(line.trim()));
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe("evaluate process command", () => {
  test("runs an external evaluator and resumes its journal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-process-cli-"));
    temporaryDirectories.push(directory);
    const runDirectory = join(directory, "run");
    const journalPath = join(directory, "evaluations.jsonl");
    const configPath = join(directory, "evaluator.json");
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "process-cli", runDirectory, { create: true });

    const digest = "a".repeat(64);
    await writeFile(
      configPath,
      JSON.stringify({
        schema_version: "1",
        evaluator: {
          id: "fixture-process",
          version: "1",
          revision: "fixture-revision",
          target_profile: "java",
          implementation_digest: digest,
        },
        suite: { id: "fixture-suite", version: "1", digest },
        requested_metrics: ["acceptance"],
        process: {
          argv: ["{bun}", "run", resolve("tests/fixtures/evaluation-process-worker.ts"), "success"],
          cwd: ".",
          env: {},
        },
        execution: {
          timeout_ms: 30_000,
          concurrency: 2,
          maximum_input_bytes: 1_048_576,
          maximum_response_bytes: 16_777_216,
          maximum_log_bytes: 1_048_576,
          termination_grace_ms: 2_000,
        },
      }),
    );

    const invoke = async () => {
      const child = Bun.spawn(
        [
          process.execPath,
          "run",
          resolve("src/cli.ts"),
          "evaluate",
          "process",
          runDirectory,
          "--config",
          configPath,
          "--journal",
          journalPath,
          "--json",
        ],
        { stdout: "pipe", stderr: "pipe", env: process.env },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(unexpectedStderr(stderr)).toEqual([]);
      expect(exitCode).toBe(0);
      return JSON.parse(stdout) as {
        executed: number;
        resumed: number;
        evaluator_strict_successes: number;
      };
    };

    const first = await invoke();
    expect(first.executed).toBe(plan.attempts.length);
    expect(first.resumed).toBe(0);
    expect(first.evaluator_strict_successes).toBe(plan.attempts.length);

    const resumed = await invoke();
    expect(resumed.executed).toBe(0);
    expect(resumed.resumed).toBe(plan.attempts.length);
    expect(await readEvaluationJournalHistory(journalPath)).toHaveLength(plan.attempts.length);
  });
});
