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
       cost: { amount: 0, currency: "USD" },
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
    budget_dimensions: Array<{ dimension: string; status: string; system_limit: number | null }>;
    executor: { error_code?: string; message?: string };
    lifecycle: string;
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

  test("refuses a harness-enforced budget dimension the adapter cannot enforce", async () => {
    const { loaded } = await scriptedBenchmark({});
    loaded.config.budget.enforcement = { total_tokens: "harness" };
    const plan = await createPlan(loaded);

    await expect(preflightSystems(loaded, plan)).rejects.toThrow(
      "cannot enforce budget dimensions declared as harness-enforced: total_tokens",
    );
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

  test("records a system ceiling at or below the declared limit as non-binding", async () => {
    const { loaded, runDirectory } = await scriptedBenchmark({
      responseOverrides: [
        {
          execution: {
            requested_seed: 1,
            seed_status: "unsupported",
            effective_parameters: {},
            effective_limits: { total_tokens: 100 },
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
});

describe("treatment attestation", () => {
  test("fails an attempt whose reported factor contradicts the configured treatment", async () => {
    const { loaded, runDirectory } = await scriptedBenchmark({
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

  test("sends requested factors and the folded target parameters to the adapter", async () => {
    const { loaded, runDirectory } = await scriptedBenchmark({});
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
