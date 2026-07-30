import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";
import { preflightSystems, runPlan } from "../src/core/run.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("experiment runner", () => {
  test("rejects a system whose effective descriptor differs from configuration", async () => {
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.revision = "misrepresented-revision";
    const plan = await createPlan(loaded);

    await expect(preflightSystems(loaded, plan)).rejects.toThrow(
      "does not match configured id/version/revision",
    );
  });

  test("persists each repetition exactly once and resumes without duplicating it", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-run-"));
    temporaryDirectories.push(parentDirectory);
    const runDirectory = join(parentDirectory, "run");
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const plan = await createPlan(loaded);

    const first = await runPlan(loaded, plan, "test-run", runDirectory, { create: true });
    expect(first.counts).toEqual({ completed: 2 });
    await expect(
      runPlan(loaded, plan, "test-run", runDirectory, { create: true }),
    ).rejects.toThrow();
    const beforeResume = await readdir(join(runDirectory, "attempts"));

    const resumed = await runPlan(loaded, plan, "test-run", runDirectory, { create: false });
    const afterResume = await readdir(join(runDirectory, "attempts"));
    expect(resumed.counts).toEqual({ completed: 2 });
    expect(afterResume.sort()).toEqual(beforeResume.sort());
    expect(new Set(afterResume).size).toBe(plan.attempts.length);

    const attemptDirectory = afterResume[0];
    if (!attemptDirectory) {
      throw new Error("run produced no attempt directory");
    }

    const secondParentDirectory = await mkdtemp(join(tmpdir(), "exgen-run-"));
    temporaryDirectories.push(secondParentDirectory);
    const secondRunDirectory = join(secondParentDirectory, "run");
    await runPlan(loaded, plan, "second-test-run", secondRunDirectory, { create: true });
    const firstRequest = JSON.parse(
      await readFile(join(runDirectory, "attempts", attemptDirectory, "request.json"), "utf8"),
    ) as { attempt: { id: string } };
    const secondRequest = JSON.parse(
      await readFile(
        join(secondRunDirectory, "attempts", attemptDirectory, "request.json"),
        "utf8",
      ),
    ) as { attempt: { id: string } };
    expect(secondRequest.attempt.id).not.toBe(firstRequest.attempt.id);

    await writeFile(
      join(
        runDirectory,
        "attempts",
        attemptDirectory,
        "output",
        "artifacts",
        "solution",
        "Exercise.java",
      ),
      "tampered\n",
    );
    await expect(
      runPlan(loaded, plan, "test-run", runDirectory, { create: false }),
    ).rejects.toThrow("evidence digest mismatch");
  });

  test("reconciles evidence finalized immediately before a ledger-write crash", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-run-"));
    temporaryDirectories.push(parentDirectory);
    const runDirectory = join(parentDirectory, "run");
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "crash-window-run", runDirectory, { create: true });
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("fixture has no attempt");
    }
    const attemptsBeforeResume = await readdir(join(runDirectory, "attempts"));

    const database = new Database(join(runDirectory, "ledger.sqlite"));
    database
      .query(
        `UPDATE attempts
         SET state = 'running', outcome = NULL, finished_at = NULL, error_code = NULL,
             artifact_digest = NULL, evidence_digest = NULL
         WHERE id = ?`,
      )
      .run(attempt.id);
    database
      .query("DELETE FROM events WHERE attempt_id = ? AND type = 'attempt.completed'")
      .run(attempt.id);
    database.close();

    const resumed = await runPlan(loaded, plan, "crash-window-run", runDirectory, {
      create: false,
    });

    expect(resumed.counts).toEqual({ completed: 2 });
    expect((await readdir(join(runDirectory, "attempts"))).sort()).toEqual(
      attemptsBeforeResume.sort(),
    );
  });

  test("rejects a second live coordinator for the same run", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-run-"));
    temporaryDirectories.push(parentDirectory);
    const runDirectory = join(parentDirectory, "run");
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.parameters = { delay_ms: 200 };
    const plan = await createPlan(loaded);

    const running = runPlan(loaded, plan, "locked-run", runDirectory, { create: true });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(join(runDirectory, ".coordinator.lock", "owner.json"));
        break;
      } catch {
        await Bun.sleep(5);
      }
    }
    await expect(
      runPlan(loaded, plan, "locked-run", runDirectory, { create: false }),
    ).rejects.toThrow("already owned");
    expect((await running).counts).toEqual({ completed: 2 });
  });
});
