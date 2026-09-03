import { Database } from "bun:sqlite";
import { generationSucceeded } from "../src/evaluation/classification.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";
import {
  acquireRunCoordinatorLock,
  preflightSystems,
  runPlan,
  untrackedSourceEntry,
} from "../src/core/run.ts";
import { loadRunEvaluationSource } from "../src/evaluation/source.ts";

const temporaryDirectories: string[] = [];
const servers: Array<ReturnType<typeof Bun.serve>> = [];

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
    protocol_version: "2",
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
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("source tree digest", () => {
  test("records a directory by path rather than hashing it as a file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-source-tree-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "embedded"));
    const entry = await untrackedSourceEntry(directory, "embedded");
    expect(entry).toEqual({ path: "embedded", embedded_repository: true });
  });

  test("still hashes an ordinary untracked file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-source-tree-"));
    temporaryDirectories.push(directory);
    await writeFile(join(directory, "notes.txt"), "hello\n");
    const entry = await untrackedSourceEntry(directory, "notes.txt");
    expect(entry).toEqual({
      path: "notes.txt",
      sha256: "5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03",
    });
  });
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

  test("records one immutable reference quote without replacing exact provider cost", async () => {
    const requested: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        requested.push(path);
        return path === "/models"
          ? Response.json({
              data: [
                {
                  id: "fixture/reference-model",
                  pricing: { prompt: "0.000001", completion: "0.000002" },
                },
              ],
            })
          : Response.json({
              data: {
                endpoints: [
                  {
                    provider_name: "fixture",
                    tag: "fixture/reference-model",
                    status: 0,
                    pricing: { prompt: "0.000001", completion: "0.000002" },
                  },
                ],
              },
            });
      },
    });
    servers.push(server);
    const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-run-"));
    temporaryDirectories.push(parentDirectory);
    const runDirectory = join(parentDirectory, "run");
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    loaded.config.reference_pricing = {
      source: "openrouter",
      base_url: `http://127.0.0.1:${server.port}`,
      timeout_ms: 5_000,
      max_response_bytes: 1024 * 1024,
      model_by_system: { "deterministic-mock": "fixture/reference-model" },
    };
    const plan = await createPlan(loaded);

    await runPlan(loaded, plan, "reference-price-run", runDirectory, { create: true });

    expect(requested.sort()).toEqual(["/models", "/models/fixture/reference-model/endpoints"]);
    const observations = await Promise.all(
      plan.attempts.map((attempt) =>
        Bun.file(join(runDirectory, "attempts", attempt.id, "observation.json")).json(),
      ),
    );
    expect(observations).toHaveLength(2);
    expect(observations[0]).toMatchObject({
      response: { cost: { amount: 0, currency: "USD" } },
      reference_cost: {
        status: "estimated",
        amount: 0,
        model: "fixture/reference-model",
        model_source: "configured",
      },
    });
    const quoteDigests = observations.map((observation) => observation.reference_cost.quote_sha256);
    expect(new Set(quoteDigests).size).toBe(1);

    const unavailableRunDirectory = join(parentDirectory, "unavailable-run");
    loaded.config.reference_pricing.model_by_system["deterministic-mock"] = "fixture/missing";
    const unavailablePlan = await createPlan(loaded);
    const unavailableSummary = await runPlan(
      loaded,
      unavailablePlan,
      "unavailable-reference-price-run",
      unavailableRunDirectory,
      { create: true },
    );
    expect(unavailableSummary.counts).toEqual({ completed: 2 });
    const unavailableObservation = await Bun.file(
      join(
        unavailableRunDirectory,
        "attempts",
        unavailablePlan.attempts[0]?.id ?? "",
        "observation.json",
      ),
    ).json();
    expect(unavailableObservation).toMatchObject({
      response: { cost: { amount: 0 } },
      reference_cost: {
        status: "unavailable",
        reason: "OpenRouter does not list model fixture/missing",
      },
    });
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
      protocol_version: "2",
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
             protocol_version: "2",
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
      protocol_version: "2",
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

interface ScriptedAdapter {
  descriptorOverrides?: Record<string, unknown>;
  capabilityOverrides?: Record<string, unknown>;
  responseOverrides?: Record<string, unknown>[];
  /** Reproduces a system that reports no cost at all, as an unpriced model does. */
  omitCost?: boolean;
}

async function scriptedBenchmark(script: ScriptedAdapter) {
  const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-scripted-"));
  temporaryDirectories.push(parentDirectory);
  const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
  const system = loaded.config.systems[0];
  if (system?.runtime.type !== "command") {
    throw new Error("fixture has no command system");
  }
  const adapterPath = join(parentDirectory, "scripted-adapter.ts");
  const counterPath = join(parentDirectory, "attempt-count");
  await writeFile(
    adapterPath,
    `import { mkdir, readFile, writeFile } from "node:fs/promises";
     import { join } from "node:path";
     const descriptor = {
       protocol_version: "2",
       kind: "generator",
       id: ${JSON.stringify(system.id)},
       version: ${JSON.stringify(system.version)},
       revision: ${JSON.stringify(system.revision)},
       runtime: { name: "bun", version: Bun.version, revision: Bun.revision },
       capabilities: {
         targets: [${JSON.stringify(loaded.config.target.id)}],
         seed: "unsupported",
         failed_artifact_capture: "complete",
         cancellation: true,
         ...${JSON.stringify(script.capabilityOverrides ?? {})},
       },
       ...${JSON.stringify(script.descriptorOverrides ?? {})},
     };
     if (process.argv[2] === "describe") {
       process.stdout.write(JSON.stringify(descriptor) + "\\n");
       process.exit(0);
     }
     let count = 0;
     try { count = Number(await readFile(${JSON.stringify(counterPath)}, "utf8")); } catch {}
     await writeFile(${JSON.stringify(counterPath)}, String(count + 1));
     const overrides = ${JSON.stringify(script.responseOverrides ?? [{}])};
     const override = overrides[Math.min(count, overrides.length - 1)];
     const output = process.argv[process.argv.indexOf("--output") + 1];
     await writeFile(join(output, "response.json"), JSON.stringify({
       protocol_version: "2",
       status: "succeeded",
       capture: { completeness: "complete" },
       artifacts: [
         { role: "problem_statement", path: "artifacts/problem-statement.md" },
         { role: "template", path: "artifacts/template" },
         { role: "solution", path: "artifacts/solution" },
         { role: "tests", path: "artifacts/tests" },
       ],
       usage: { model_calls: 1, tool_calls: 0, input_tokens: 10, output_tokens: 10, total_tokens: 20 },
       ...(${JSON.stringify(script.omitCost === true)} ? {} : { cost: { amount: 0, currency: "USD" } }),
       ...override,
     }) + "\\n");
     for (const role of ["template", "solution", "tests"]) {
       await mkdir(join(output, "artifacts", role), { recursive: true });
       await writeFile(join(output, "artifacts", role, "Exercise.java"), role + "\\n");
     }
     await writeFile(join(output, "artifacts", "problem-statement.md"), "# fixture\\n");`,
  );
  system.runtime.command = ["{bun}", "run", adapterPath];
  loaded.config.trials.replicates = 1;
  return { loaded, parentDirectory, runDirectory: join(parentDirectory, "run") };
}

async function observationOf(runDirectory: string, attemptId: string) {
  return JSON.parse(
    await readFile(join(runDirectory, "attempts", attemptId, "observation.json"), "utf8"),
  ) as {
    budget: { status: string; violations: string[]; missing: string[] };
    budget_dimensions: Array<{
      dimension: string;
      status: string;
      system_limit: number | null;
      declared_limit: number | null;
      observed: number | null;
    }>;
    executor: { error_code?: string; message?: string };
    lifecycle: string;
    outcome?: string;
  };
}

describe("treatment preflight", () => {
  test("lets a second arm identify itself from its declared environment", async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-two-arm-"));
    temporaryDirectories.push(parentDirectory);
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const first = loaded.config.systems[0];
    if (first?.runtime.type !== "command") {
      throw new Error("fixture has no command system");
    }
    const adapterPath = join(parentDirectory, "env-identified-adapter.ts");
    await writeFile(
      adapterPath,
      `const id = process.env.EXGEN_ADAPTER_ID || "fallback-id";
       process.stdout.write(JSON.stringify({
         protocol_version: "2",
         kind: "generator",
         id,
         version: "1",
         revision: "source-tree",
         runtime: { name: "bun", version: Bun.version, revision: Bun.revision },
         capabilities: {
           targets: ["artemis-java-maven"],
           seed: "unsupported",
           failed_artifact_capture: "complete",
           cancellation: true,
           observes: ["model"],
         },
       }) + "\\n");`,
    );
    process.env.ARM_A_ID = "arm-a";
    process.env.ARM_B_ID = "arm-b";
    const arm = (id: string, source: string) => ({
      ...structuredClone(first),
      id,
      name: id,
      revision: "source-tree",
      runtime: {
        type: "command" as const,
        command: ["{bun}", "run", adapterPath],
        env: { EXGEN_ADAPTER_ID: source },
      },
      factors: {
        ...first.factors,
        model: { value: id, control: "observed" as const },
      },
    });
    loaded.config.systems = [arm("arm-a", "ARM_A_ID"), arm("arm-b", "ARM_B_ID")];

    const plan = await createPlan(loaded);
    const descriptors = await preflightSystems(loaded, plan);

    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(["arm-a", "arm-b"]);
  });

  test("rejects a system parameter the descriptor's published schema does not declare", async () => {
    const { loaded } = await scriptedBenchmark({
      descriptorOverrides: {
        parameters_schema: {
          type: "object",
          additionalProperties: false,
          properties: { delay_ms: { type: "number" } },
        },
      },
    });
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.parameters = { delay_mss: 5 };
    const plan = await createPlan(loaded);

    await expect(preflightSystems(loaded, plan)).rejects.toThrow(
      "do not satisfy the declared parameters schema",
    );
  });

  test("enforces standard constraints and formats in a declared parameters schema", async () => {
    const parametersSchema = {
      type: "object",
      additionalProperties: false,
      required: ["delay_ms", "endpoint"],
      properties: {
        delay_ms: { type: "number", minimum: 1 },
        endpoint: { type: "string", format: "uri" },
      },
    };
    for (const parameters of [
      { delay_ms: 0, endpoint: "https://example.com" },
      { delay_ms: 1, endpoint: "not a URI" },
    ]) {
      const { loaded } = await scriptedBenchmark({
        descriptorOverrides: { parameters_schema: parametersSchema },
      });
      const system = loaded.config.systems[0];
      if (!system) throw new Error("fixture has no system");
      system.parameters = parameters;

      await expect(preflightSystems(loaded, await createPlan(loaded))).rejects.toThrow(
        "do not satisfy the declared parameters schema",
      );
    }
  });

  test("enforces oneOf exclusivity in a declared parameters schema", async () => {
    const { loaded } = await scriptedBenchmark({
      descriptorOverrides: {
        parameters_schema: {
          type: "object",
          additionalProperties: false,
          required: ["mode"],
          properties: { mode: { type: "string" } },
          oneOf: [
            { type: "object", properties: { mode: { const: "draft" } } },
            { type: "object", properties: { mode: { type: "string" } } },
          ],
        },
      },
    });
    const system = loaded.config.systems[0];
    if (!system) throw new Error("fixture has no system");
    system.parameters = { mode: "draft" };

    await expect(preflightSystems(loaded, await createPlan(loaded))).rejects.toThrow(
      "must match exactly one schema in oneOf",
    );
  });

  test("rejects an invalid declared parameters schema", async () => {
    const { loaded } = await scriptedBenchmark({
      descriptorOverrides: { parameters_schema: { $ref: "#/$defs/missing" } },
    });

    await expect(preflightSystems(loaded, await createPlan(loaded))).rejects.toThrow(
      "declared an invalid parameters_schema",
    );
  });

  test("refuses a harness-enforced budget dimension the adapter cannot enforce", async () => {
    const { loaded } = await scriptedBenchmark({});
    loaded.config.budget.enforcement = { total_tokens: "harness" };
    const plan = await createPlan(loaded);

    await expect(preflightSystems(loaded, plan)).rejects.toThrow(
      "cannot enforce budget dimensions declared as harness-enforced: total_tokens",
    );
  });

  test("refuses a requested factor the adapter does not declare it controls", async () => {
    const { loaded } = await scriptedBenchmark({
      capabilityOverrides: { controls: ["temperature"] },
    });
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.factors = { effort_profile: { value: "thorough", control: "requested" } };
    const plan = await createPlan(loaded);

    await expect(preflightSystems(loaded, plan)).rejects.toThrow(
      "declares requested factor(s) effort_profile that the adapter does not control (it declares temperature)",
    );
  });

  test("refuses an observed factor the adapter does not declare it observes", async () => {
    const { loaded } = await scriptedBenchmark({
      capabilityOverrides: { controls: ["effort_profile"], observes: ["effort_profile"] },
    });
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.factors = { max_tokens: { value: 600000, control: "observed" } };
    const plan = await createPlan(loaded);

    await expect(preflightSystems(loaded, plan)).rejects.toThrow(
      "declares observed factor(s) max_tokens that the adapter does not observe (it declares effort_profile)",
    );
  });

  test("treats an adapter that declares neither capability as controlling nothing", async () => {
    const { loaded } = await scriptedBenchmark({});
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.factors = { effort_profile: { value: "thorough", control: "requested" } };
    const plan = await createPlan(loaded);

    await expect(preflightSystems(loaded, plan)).rejects.toThrow(
      "the adapter does not control (it declares none)",
    );
  });

  test("accepts a factor an adapter declaring nothing leaves unverified", async () => {
    const { loaded } = await scriptedBenchmark({});
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.factors = { effort_profile: { value: "thorough", control: "declared" } };
    const plan = await createPlan(loaded);

    await expect(preflightSystems(loaded, plan)).resolves.toHaveLength(1);
  });
});

describe("budget accounting", () => {
  test("records an undeclared dimension as unverifiable rather than compliant", async () => {
    const { loaded, runDirectory } = await scriptedBenchmark({});
    loaded.config.budget = { wall_time_ms: 30_000, enforcement: {} };
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "undeclared-budget", runDirectory, { create: true });
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("plan has no attempt");
    }

    const observation = await observationOf(runDirectory, attempt.id);

    expect(observation.budget.status).toBe("unverifiable");
    expect(observation.budget.missing).toContain("total_tokens:undeclared");
  });

  test("treats a dimension that was neither bounded nor consumed as non-binding", async () => {
    // A model with no configured price reports no cost at all. Calling that unverifiable would make
    // the strict estimand unattainable for every attempt of every campaign against an unpriced
    // model, while describing nothing about the run.
    // An unpriced model reports no cost field at all.
    const { loaded, runDirectory } = await scriptedBenchmark({ omitCost: true });
    loaded.config.budget = {
      wall_time_ms: 30_000,
      max_model_calls: 1_000,
      max_tool_calls: 1_000,
      max_input_tokens: 1_000_000,
      max_output_tokens: 1_000_000,
      max_total_tokens: 1_000_000,
      enforcement: {},
    };
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "unconstrained-cost", runDirectory, { create: true });
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("plan has no attempt");
    }

    const observation = await observationOf(runDirectory, attempt.id);
    const cost = observation.budget_dimensions.find((entry) => entry.dimension === "cost");

    expect(cost?.observed).toBeNull();
    expect(cost?.declared_limit).toBeNull();
    expect(cost?.status).toBe("non_binding");
    expect(observation.budget.missing).not.toContain("cost:undeclared");
    // The whole point: an unpriced model must not sink the attempt's budget verdict. non_binding is
    // the honest overall verdict here and is what generationSucceeded's withinBudget() accepts;
    // unverifiable is not, and would have made the strict estimand unattainable for every attempt.
    expect(observation.budget.status).toBe("non_binding");
    expect(
      generationSucceeded({
        state: "completed",
        outcome: "succeeded",
        budget_status: "non_binding",
      }),
    ).toBe(true);
  });

  test("records a system ceiling at or below the declared limit as non-binding", async () => {
    const { loaded, runDirectory } = await scriptedBenchmark({
      responseOverrides: [
        {
          execution: {
            requested_seed: 1,
            seed_status: "unsupported",
            effective_parameters: {},
            effective_limits: { total_tokens: { value: 100, source: "system_reported" } },
            provider_request_ids: [],
            provider_request_ids_complete: true,
          },
        },
      ],
    });
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "non-binding-budget", runDirectory, { create: true });
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("plan has no attempt");
    }

    const observation = await observationOf(runDirectory, attempt.id);
    const totalTokens = observation.budget_dimensions.find(
      (dimension) => dimension.dimension === "total_tokens",
    );

    expect(totalTokens?.status).toBe("non_binding");
    expect(totalTokens?.system_limit).toBe(100);
    expect(observation.budget.status).toBe("non_binding");
  });

  test("refuses non-binding for a ceiling the system did not report", async () => {
    const sourced = (limit: unknown) => ({
      execution: {
        requested_seed: 1,
        seed_status: "unsupported",
        effective_parameters: {},
        effective_limits: { total_tokens: limit },
        provider_request_ids: [],
        provider_request_ids_complete: true,
      },
    });
    for (const [label, limit] of [
      ["unsourced", 100],
      ["operator-declared", { value: 100, source: "system_configured" }],
    ] as const) {
      const { loaded, runDirectory } = await scriptedBenchmark({
        responseOverrides: [sourced(limit)],
      });
      const plan = await createPlan(loaded);
      await runPlan(loaded, plan, `unsourced-ceiling-${label}`, runDirectory, { create: true });
      const attempt = plan.attempts[0];
      if (!attempt) {
        throw new Error("plan has no attempt");
      }

      const observation = await observationOf(runDirectory, attempt.id);
      const totalTokens = observation.budget_dimensions.find(
        (dimension) => dimension.dimension === "total_tokens",
      );

      expect(totalTokens?.status, label).toBe("compliant");
      expect(totalTokens?.system_limit, label).toBe(100);
      expect(observation.budget.status, label).not.toBe("non_binding");
    }
  });
});

describe("treatment attestation", () => {
  test("fails an attempt whose reported factor contradicts the configured treatment", async () => {
    const { loaded, runDirectory } = await scriptedBenchmark({
      capabilityOverrides: { observes: ["model"] },
      responseOverrides: [
        {
          execution: {
            requested_seed: 1,
            seed_status: "unsupported",
            effective_parameters: {},
            observed_factors: { model: "something-else" },
            provider_request_ids: [],
            provider_request_ids_complete: true,
          },
        },
      ],
    });
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.factors = { model: { value: "declared-model", control: "observed" } };
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "factor-mismatch", runDirectory, { create: true });
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("plan has no attempt");
    }

    const observation = await observationOf(runDirectory, attempt.id);

    expect(observation.lifecycle).toBe("failed");
    expect(observation.executor.error_code).toBe("generator.attestation_mismatch");
    expect(observation.executor.message).toContain("system reported");
  });

  test("fails an attempt whose seed status contradicts the declared seed capability", async () => {
    const { loaded, runDirectory } = await scriptedBenchmark({
      capabilityOverrides: { seed: "deterministic" },
      responseOverrides: [
        {
          execution: {
            requested_seed: 1,
            seed_status: "unverifiable",
            effective_parameters: {},
            provider_request_ids: [],
            provider_request_ids_complete: true,
          },
        },
      ],
    });
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "seed-contradiction", runDirectory, { create: true });
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("plan has no attempt");
    }

    const observation = await observationOf(runDirectory, attempt.id);

    expect(observation.lifecycle).toBe("failed");
    expect(observation.executor.message).toContain("seed=deterministic");
  });

  test("fails an attempt whose system configuration drifted from the first attempt", async () => {
    const execution = (limit: number) => ({
      execution: {
        requested_seed: 1,
        seed_status: "unsupported",
        effective_parameters: {},
        effective_limits: { total_tokens: limit },
        provider_request_ids: [],
        provider_request_ids_complete: true,
      },
    });
    const { loaded, runDirectory } = await scriptedBenchmark({
      responseOverrides: [execution(2000), execution(1000)],
    });
    loaded.config.trials.replicates = 2;
    loaded.config.execution.concurrency = 1;
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "configuration-drift", runDirectory, { create: true });

    const observations = await Promise.all(
      plan.attempts.map((attempt) => observationOf(runDirectory, attempt.id)),
    );
    const drifted = observations.filter(
      (observation) => observation.executor.error_code === "generator.attestation_mismatch",
    );

    expect(drifted).toHaveLength(1);
    expect(drifted[0]?.executor.message).toContain("system configuration changed since attempt");
  });

  test("compares configuration only between attempts with the same requested scope", async () => {
    const execution = (format: string) => ({
      execution: {
        requested_seed: 1,
        seed_status: "unsupported",
        effective_parameters: { format },
        provider_request_ids: [],
        provider_request_ids_complete: true,
      },
    });
    const { loaded, runDirectory } = await scriptedBenchmark({
      responseOverrides: [execution("java"), execution("kotlin")],
    });
    const firstCase = loaded.dataset.cases[0];
    if (!firstCase) throw new Error("fixture has no case");
    loaded.dataset.cases.push({ ...firstCase, id: "second-case", title: "Second case" });
    loaded.config.target.parameters.case_overrides = {
      "second-case": { language: "kotlin" },
    };
    loaded.config.execution.concurrency = 1;
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "request-scoped-configuration", runDirectory, { create: true });

    const observations = await Promise.all(
      plan.attempts.map((attempt) => observationOf(runDirectory, attempt.id)),
    );
    expect(
      observations.filter(
        (observation) => observation.executor.error_code === "generator.attestation_mismatch",
      ),
    ).toHaveLength(0);
  });

  test("includes the reported model in configuration drift detection", async () => {
    const model = (id: string) => ({
      model: { provider: "provider", id },
      execution: {
        requested_seed: 1,
        seed_status: "unsupported",
        effective_parameters: {},
        provider_request_ids: [],
        provider_request_ids_complete: true,
      },
    });
    const { loaded, runDirectory } = await scriptedBenchmark({
      responseOverrides: [model("model-a"), model("model-b")],
    });
    loaded.config.trials.replicates = 2;
    loaded.config.execution.concurrency = 1;
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "model-configuration-drift", runDirectory, { create: true });

    const observations = await Promise.all(
      plan.attempts.map((attempt) => observationOf(runDirectory, attempt.id)),
    );
    expect(
      observations.filter(
        (observation) => observation.executor.error_code === "generator.attestation_mismatch",
      ),
    ).toHaveLength(1);
  });

  test("does not let a partial failed response establish the configuration baseline", async () => {
    const execution = (effectiveParameters: Record<string, unknown>) => ({
      execution: {
        requested_seed: 1,
        seed_status: "unsupported",
        effective_parameters: effectiveParameters,
        provider_request_ids: [],
        provider_request_ids_complete: true,
      },
    });
    const { loaded, runDirectory } = await scriptedBenchmark({
      responseOverrides: [
        {
          status: "failed",
          artifacts: [],
          capture: { completeness: "none", reason: "generation failed before configuration" },
          ...execution({}),
        },
        execution({ model: "reported-after-generation" }),
      ],
    });
    loaded.config.trials.replicates = 2;
    loaded.config.execution.concurrency = 1;
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "failed-configuration-baseline", runDirectory, { create: true });

    const observations = await Promise.all(
      plan.attempts.map((attempt) => observationOf(runDirectory, attempt.id)),
    );

    expect(observations.map((observation) => observation.outcome)).toEqual(["failed", "succeeded"]);
    expect(observations.map((observation) => observation.lifecycle)).toEqual([
      "completed",
      "completed",
    ]);
    expect(observations.every((observation) => observation.executor.error_code === undefined)).toBe(
      true,
    );
  });

  test("still checks treatment factors reported by a failed generation", async () => {
    const { loaded, runDirectory } = await scriptedBenchmark({
      capabilityOverrides: { observes: ["model"] },
      responseOverrides: [
        {
          status: "failed",
          artifacts: [],
          capture: { completeness: "none", reason: "generation failed" },
          execution: {
            requested_seed: 1,
            seed_status: "unsupported",
            effective_parameters: {},
            observed_factors: { model: "something-else" },
            provider_request_ids: [],
            provider_request_ids_complete: true,
          },
        },
      ],
    });
    const system = loaded.config.systems[0];
    if (!system) {
      throw new Error("fixture has no system");
    }
    system.factors = { model: { value: "declared-model", control: "observed" } };
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "failed-factor-mismatch", runDirectory, { create: true });
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("plan has no attempt");
    }

    const observation = await observationOf(runDirectory, attempt.id);

    expect(observation.lifecycle).toBe("failed");
    expect(observation.executor.error_code).toBe("generator.attestation_mismatch");
    expect(observation.executor.message).toContain("system reported");
  });

  test("sends requested factors and the folded target parameters to the adapter", async () => {
    const { loaded, runDirectory } = await scriptedBenchmark({
      capabilityOverrides: { controls: ["model"] },
    });
    const system = loaded.config.systems[0];
    const datasetCase = loaded.dataset.cases[0];
    if (!system || !datasetCase) {
      throw new Error("fixture is incomplete");
    }
    system.factors = {
      model: { value: "sent-model", control: "requested" },
      approach: { value: "not-sent", control: "declared" },
    };
    loaded.config.target.parameters.case_overrides = { [datasetCase.id]: { language: "kotlin" } };
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "request-shape", runDirectory, { create: true });
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("plan has no attempt");
    }

    const request = JSON.parse(
      await readFile(join(runDirectory, "attempts", attempt.id, "request.json"), "utf8"),
    ) as { factors: Record<string, unknown>; target: { parameters: Record<string, unknown> } };

    expect(request.factors).toEqual({ model: "sent-model" });
    expect(request.target.parameters).toEqual({ language: "kotlin", build_system: "maven" });
  });
});

describe("evaluation source", () => {
  async function runWithRetainedCandidate(status: "succeeded" | "failed") {
    const { loaded, runDirectory } = await scriptedBenchmark({
      responseOverrides: [
        status === "succeeded"
          ? {}
          : { status: "failed", capture: { completeness: "partial", reason: "not accepted" } },
      ],
    });
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, `retained-${status}`, runDirectory, { create: true });
    return { runDirectory, plan };
  }

  test("offers a retained candidate from a generation the system did not accept", async () => {
    const { runDirectory } = await runWithRetainedCandidate("failed");

    const source = await loadRunEvaluationSource(runDirectory);

    expect(source.generations.map((row) => row.outcome)).toEqual(["failed"]);
    expect(source.candidates).toHaveLength(1);
    expect(source.candidates[0]?.capture_completeness).toBe("partial");
  });

  test("reports a complete capture to the evaluator when the whole workspace was captured", async () => {
    const { runDirectory } = await runWithRetainedCandidate("succeeded");

    const source = await loadRunEvaluationSource(runDirectory);

    expect(source.candidates[0]?.capture_completeness).toBe("complete");
  });

  test("offers no candidate for an attempt the harness did not trust", async () => {
    const { loaded, runDirectory } = await scriptedBenchmark({
      responseOverrides: [
        {
          status: "infra_failed",
          capture: { completeness: "partial", reason: "infrastructure" },
        },
      ],
    });
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "infra-failed-candidate", runDirectory, { create: true });

    const source = await loadRunEvaluationSource(runDirectory);

    expect(source.generations[0]?.state).toBe("failed");
    expect(source.candidates).toEqual([]);
  });

  test("loads a run written before deployment attestation and records the gap", async () => {
    const { loaded, runDirectory } = await scriptedBenchmark({});
    const plan = await createPlan(loaded);
    await runPlan(loaded, plan, "legacy-unattested", runDirectory, { create: true });
    const manifestPath = join(runDirectory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      plan: { systems: Array<Record<string, unknown>> };
    };
    for (const system of manifest.plan.systems) {
      delete system.attestation;
    }
    await writeFile(manifestPath, JSON.stringify(manifest));

    const source = await loadRunEvaluationSource(runDirectory);

    expect(source.attestation.unattested_systems).toEqual(["deterministic-mock"]);
    expect(source.systems[0]?.attestation).toBeUndefined();
    expect(source.candidates).toHaveLength(1);
  });
});
