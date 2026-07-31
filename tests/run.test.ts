import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";
import { acquireRunCoordinatorLock, preflightSystems, runPlan } from "../src/core/run.ts";

const temporaryDirectories: string[] = [];

async function prepareCrashedRemoteAttempt(options: { hangOnRecovery?: boolean } = {}) {
  const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-run-"));
  temporaryDirectories.push(parentDirectory);
  const runDirectory = join(parentDirectory, "run");
  const wrapperPath = join(parentDirectory, "recoverable-adapter.ts");
  const callsPath = join(parentDirectory, "calls.log");
  const recoveryPidPath = join(parentDirectory, "recovery.pid");
  const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
  const system = loaded.config.systems[0];
  if (system?.runtime.type !== "command") {
    throw new Error("fixture has no command system");
  }
  const descriptor = {
    protocol_version: "1",
    kind: "generator",
    id: system.id,
    version: system.version,
    revision: system.revision,
    runtime: { name: "bun", version: Bun.version, revision: Bun.revision },
    capabilities: {
      targets: [loaded.config.target.id],
      seed: "deterministic",
      failed_artifact_capture: "complete",
      cancellation: true,
      crash_recovery: "cancel",
    },
  };
  const recoveryBehavior = options.hangOnRecovery
    ? `await Bun.write(${JSON.stringify(recoveryPidPath)}, String(process.pid));
       process.on("SIGTERM", () => {});
       process.stdout.write("x".repeat(1024 * 1024 + 1));
       setInterval(() => {}, 1_000);`
    : "";
  await writeFile(
    wrapperPath,
    `import { appendFile } from "node:fs/promises";
     const command = process.argv[2];
     if (command === "describe") {
       process.stdout.write(${JSON.stringify(`${JSON.stringify(descriptor)}\n`)});
     } else if (command === "recover") {
       await appendFile(${JSON.stringify(callsPath)}, "recover\\n");
       ${recoveryBehavior}
     } else {
       await appendFile(${JSON.stringify(callsPath)}, "generate\\n");
       await import(${JSON.stringify(resolve("examples/mock-generator.ts"))});
     }`,
  );
  system.runtime.command = ["{bun}", "run", wrapperPath];
  loaded.config.trials.replicates = 1;
  const plan = await createPlan(loaded);
  const runId = `remote-recovery-${crypto.randomUUID()}`;
  await runPlan(loaded, plan, runId, runDirectory, { create: true });
  const attempt = plan.attempts[0];
  if (!attempt) {
    throw new Error("fixture has no attempt");
  }
  const finalDirectory = join(runDirectory, "attempts", attempt.id);
  const request = JSON.parse(await readFile(join(finalDirectory, "request.json"), "utf8")) as {
    output_dir: string;
  };
  await rename(finalDirectory, resolve(request.output_dir, ".."));
  const database = new Database(join(runDirectory, "ledger.sqlite"));
  database
    .query(
      `UPDATE attempts
       SET state = 'running', outcome = NULL, finished_at = NULL, error_code = NULL,
           artifact_digest = NULL, evidence_digest = NULL
       WHERE id = ?`,
    )
    .run(attempt.id);
  database.close();
  return { callsPath, loaded, plan, recoveryPidPath, runDirectory, runId };
}

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
        await access(join(runDirectory, ".coordinator.sqlite"));
        break;
      } catch {
        await Bun.sleep(5);
      }
    }
    await expect(
      runPlan(loaded, plan, "locked-run", runDirectory, { create: false }),
    ).rejects.toThrow("already owned");
    expect((await running).counts).toEqual({ completed: 2 });
    const release = await acquireRunCoordinatorLock(runDirectory);
    await release();
  });

  test("finalizes an unexpected runner failure without fabricating adapter output", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-run-"));
    temporaryDirectories.push(parentDirectory);
    const runDirectory = join(parentDirectory, "run");
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const plan = await createPlan(loaded);
    plan.cases.length = 0;

    await expect(
      runPlan(loaded, plan, "unexpected-runner-failure", runDirectory, { create: true }),
    ).rejects.toThrow("runner task(s) failed unexpectedly");

    const database = new Database(join(runDirectory, "ledger.sqlite"));
    const rows = database
      .query<{ state: string; error_code: string | null; evidence_digest: string | null }, []>(
        "SELECT state, error_code, evidence_digest FROM attempts ORDER BY ordinal",
      )
      .all();
    database.close();
    expect(rows[0]?.state).toBe("interrupted");
    expect(rows[0]?.error_code).toBe("runner.interrupted");
    expect(rows[0]?.evidence_digest).toMatch(/^[a-f0-9]{64}$/);
    const attemptDirectory = join(runDirectory, "attempts", plan.attempts[0]?.id ?? "");
    expect(
      JSON.parse(await readFile(join(attemptDirectory, "observation.json"), "utf8")).lifecycle,
    ).toBe("interrupted");
    expect(await Bun.file(join(attemptDirectory, "evidence-manifest.json")).exists()).toBe(true);
    expect(await Bun.file(join(attemptDirectory, "response.json")).exists()).toBe(false);
  });

  test("keeps uncertain remote work recoverable until cleanup succeeds", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-run-"));
    temporaryDirectories.push(parentDirectory);
    const runDirectory = join(parentDirectory, "run");
    const adapterPath = join(parentDirectory, "recoverable-failure-adapter.ts");
    const callsPath = join(parentDirectory, "calls.log");
    const recoveryCountPath = join(parentDirectory, "recovery-count");
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const system = loaded.config.systems[0];
    if (system?.runtime.type !== "command") {
      throw new Error("fixture has no command system");
    }
    const descriptor = {
      protocol_version: "1",
      kind: "generator",
      id: system.id,
      version: system.version,
      revision: system.revision,
      runtime: { name: "bun", version: Bun.version, revision: Bun.revision },
      capabilities: {
        targets: [loaded.config.target.id],
        seed: "deterministic",
        failed_artifact_capture: "complete",
        cancellation: true,
        crash_recovery: "cancel",
      },
    };
    await writeFile(
      adapterPath,
      `import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
       import { join } from "node:path";
       const command = process.argv[2];
       if (command === "describe") {
         process.stdout.write(${JSON.stringify(`${JSON.stringify(descriptor)}\n`)});
       } else if (command === "generate") {
         await appendFile(${JSON.stringify(callsPath)}, "generate\\n");
         const output = process.argv[process.argv.indexOf("--output") + 1];
         await mkdir(output, { recursive: true });
         await writeFile(join(output, "response.json"), ${JSON.stringify(
           `${JSON.stringify({
             protocol_version: "1",
             status: "infra_failed",
             artifacts: [],
             capture: { completeness: "none", reason: "fixture failure" },
           })}\n`,
         )});
       } else if (command === "recover") {
         await appendFile(${JSON.stringify(callsPath)}, "recover\\n");
         let count = 0;
         try { count = Number(await readFile(${JSON.stringify(recoveryCountPath)}, "utf8")); } catch {}
         await writeFile(${JSON.stringify(recoveryCountPath)}, String(count + 1));
         if (count === 0) process.exit(1);
       }`,
    );
    system.runtime.command = ["{bun}", "run", adapterPath];
    loaded.config.trials.replicates = 1;
    const plan = await createPlan(loaded);

    await expect(
      runPlan(loaded, plan, "pending-recovery", runDirectory, { create: true }),
    ).rejects.toThrow("runner task");
    let database = new Database(join(runDirectory, "ledger.sqlite"));
    expect(database.query<{ state: string }, []>("SELECT state FROM attempts").get()?.state).toBe(
      "running",
    );
    database.close();

    const resumed = await runPlan(loaded, plan, "pending-recovery", runDirectory, {
      create: false,
    });
    expect(resumed.counts).toEqual({ interrupted: 1 });
    expect((await readFile(callsPath, "utf8")).trim().split("\n")).toEqual([
      "generate",
      "recover",
      "recover",
    ]);
    database = new Database(join(runDirectory, "ledger.sqlite"));
    const finalized = database
      .query<{ state: string; evidence_digest: string | null }, []>(
        "SELECT state, evidence_digest FROM attempts",
      )
      .get();
    expect(finalized?.state).toBe("interrupted");
    expect(finalized?.evidence_digest).toMatch(/^[a-f0-9]{64}$/);
    database.close();
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("fixture has no attempt");
    }
    expect(await readdir(join(runDirectory, ".work"))).toEqual([]);
    expect(
      JSON.parse(
        await readFile(join(runDirectory, "attempts", attempt.id, "observation.json"), "utf8"),
      ),
    ).toMatchObject({
      lifecycle: "interrupted",
      executor: { error_code: "runner.interrupted" },
    });
  });

  test("recovers durable remote work without invoking generation twice", async () => {
    const { callsPath, loaded, plan, runDirectory, runId } = await prepareCrashedRemoteAttempt();
    const resumed = await runPlan(loaded, plan, runId, runDirectory, {
      create: false,
    });

    expect(resumed.counts).toEqual({ interrupted: 1 });
    expect((await readFile(callsPath, "utf8")).trim().split("\n")).toEqual(["generate", "recover"]);
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("fixture has no attempt");
    }
    expect(await readdir(join(runDirectory, ".work"))).toEqual([]);
    await access(join(runDirectory, "attempts", attempt.id, "evidence-manifest.json"));
  });

  test("bounds and reaps a crash-recovery subprocess before changing ledger state", async () => {
    const { loaded, plan, recoveryPidPath, runDirectory, runId } =
      await prepareCrashedRemoteAttempt({ hangOnRecovery: true });
    const started = performance.now();

    await expect(runPlan(loaded, plan, runId, runDirectory, { create: false })).rejects.toThrow(
      "stream exceeds",
    );

    expect(performance.now() - started).toBeLessThan(4_000);
    const recoveryPid = Number(await readFile(recoveryPidPath, "utf8"));
    expect(() => process.kill(recoveryPid, 0)).toThrow();
    const database = new Database(join(runDirectory, "ledger.sqlite"));
    const state = database.query<{ state: string }, []>("SELECT state FROM attempts").get()?.state;
    database.close();
    expect(state).toBe("running");
  }, 8_000);

  test("force-kills a command adapter that ignores graceful termination", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-run-"));
    temporaryDirectories.push(parentDirectory);
    const runDirectory = join(parentDirectory, "run");
    const adapterPath = join(parentDirectory, "term-ignoring-adapter.ts");
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const system = loaded.config.systems[0];
    if (system?.runtime.type !== "command") {
      throw new Error("fixture has no command system");
    }
    const descriptor = JSON.stringify({
      protocol_version: "1",
      kind: "generator",
      id: system.id,
      version: system.version,
      revision: system.revision,
      runtime: { name: "bun", version: Bun.version, revision: Bun.revision },
      capabilities: {
        targets: [loaded.config.target.id],
        seed: "deterministic",
        failed_artifact_capture: "complete",
        cancellation: true,
      },
    });
    await writeFile(
      adapterPath,
      `if (process.argv[2] === "describe") {
          process.stdout.write(${JSON.stringify(`${descriptor}\n`)});
          process.exit(0);
        }
        process.on("SIGTERM", () => {});
        setInterval(() => {}, 1_000);`,
    );
    system.runtime.command = ["{bun}", "run", adapterPath];
    loaded.config.budget.wall_time_ms = 25;
    loaded.config.trials.replicates = 1;
    const plan = await createPlan(loaded);

    const started = performance.now();
    const summary = await runPlan(loaded, plan, "forced-termination", runDirectory, {
      create: true,
    });

    expect(summary.counts).toEqual({ failed: 1 });
    expect(performance.now() - started).toBeLessThan(4_000);
  }, 8_000);
});
