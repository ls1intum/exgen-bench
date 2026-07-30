import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { systemSchema } from "../src/contracts.ts";
import { sha256 } from "../src/core/canonical.ts";
import { loadBenchmark } from "../src/core/load.ts";
import { createPlan } from "../src/core/plan.ts";
import { runPlan } from "../src/core/run.ts";

const ALPINE_IMAGE =
  "alpine@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce";
const temporaryDirectories: string[] = [];
const containerNames: string[] = [];
const containerTest = process.env.EXGEN_CONTAINER_INTEGRATION === "1" ? test : test.skip;

afterEach(async () => {
  for (const name of containerNames.splice(0)) {
    Bun.spawnSync(["docker", "rm", "--force", name], { stderr: "ignore", stdout: "ignore" });
  }
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

containerTest(
  "removes timed-out and crash-orphaned containers whose workloads ignore SIGTERM",
  async () => {
    const parentDirectory = await mkdtemp(join(tmpdir(), "exgen-container-"));
    temporaryDirectories.push(parentDirectory);
    const loaded = await loadBenchmark(resolve("examples/smoke/benchmark.yaml"));
    const original = loaded.config.systems[0];
    if (!original) {
      throw new Error("fixture has no system");
    }
    const descriptor = JSON.stringify({
      protocol_version: "1",
      kind: "generator",
      id: original.id,
      version: original.version,
      revision: original.revision,
      runtime: { name: "alpine", version: "3.22.5" },
      capabilities: {
        targets: [loaded.config.target.id],
        seed: "unsupported",
        failed_artifact_capture: "none",
        cancellation: false,
      },
    });
    const script = `if [ "$1" = describe ]; then
      printf '%s\\n' '${descriptor}';
      exit 0;
    fi
    trap '' TERM
    while :; do sleep 1; done`;
    loaded.config.systems[0] = systemSchema.parse({
      ...original,
      runtime: {
        type: "container",
        engine: "docker",
        image: ALPINE_IMAGE,
        command: ["sh", "-c", script, "adapter"],
        network: "none",
        memory_mb: 64,
        cpus: 0.5,
        user: "65534:65534",
      },
    });
    loaded.config.budget.wall_time_ms = 50;
    loaded.config.trials.replicates = 1;
    const plan = await createPlan(loaded);
    const runDirectory = join(parentDirectory, "run");
    const summary = await runPlan(loaded, plan, "container-timeout", runDirectory, {
      create: true,
    });

    expect(summary.counts).toEqual({ failed: 1 });
    const manifest = JSON.parse(await readFile(join(runDirectory, "manifest.json"), "utf8")) as {
      run_instance_id: string;
    };
    const attempt = plan.attempts[0];
    if (!attempt) {
      throw new Error("fixture has no planned attempt");
    }
    const containerName = `exgen-attempt-${sha256(
      `${manifest.run_instance_id}\0${attempt.id}`,
    ).slice(0, 32)}`;
    const preflightNamespace = sha256(resolve(runDirectory)).slice(0, 32);
    const preflightName = `exgen-preflight-${sha256(`${preflightNamespace}\0${original.id}`).slice(
      0,
      32,
    )}`;
    containerNames.push(containerName, preflightName);
    const inspection = Bun.spawnSync(["docker", "inspect", containerName], { stderr: "ignore" });
    expect(inspection.exitCode).not.toBe(0);

    const database = new Database(join(runDirectory, "ledger.sqlite"));
    database
      .query(
        `UPDATE attempts
         SET state = 'running', finished_at = NULL, outcome = NULL, error_code = NULL,
             artifact_digest = NULL, evidence_digest = NULL
         WHERE id = ?`,
      )
      .run(attempt.id);
    database.close();
    const orphan = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "--name",
        containerName,
        "--network",
        "none",
        ALPINE_IMAGE,
        "sh",
        "-c",
        "trap '' TERM; while :; do sleep 1; done",
      ],
      { stderr: "ignore", stdout: "ignore" },
    );
    const preflightOrphan = Bun.spawn(
      [
        "docker",
        "run",
        "--rm",
        "--name",
        preflightName,
        "--network",
        "none",
        ALPINE_IMAGE,
        "sh",
        "-c",
        "trap '' TERM; while :; do sleep 1; done",
      ],
      { stderr: "ignore", stdout: "ignore" },
    );
    for (let poll = 0; poll < 100; poll += 1) {
      const attemptExists =
        Bun.spawnSync(["docker", "inspect", containerName], { stderr: "ignore" }).exitCode === 0;
      const preflightExists =
        Bun.spawnSync(["docker", "inspect", preflightName], { stderr: "ignore" }).exitCode === 0;
      if (attemptExists && preflightExists) {
        break;
      }
      await Bun.sleep(20);
    }

    const resumed = await runPlan(loaded, plan, "container-timeout", runDirectory, {
      create: false,
    });
    await Promise.all([orphan.exited, preflightOrphan.exited]);
    expect(resumed.counts).toEqual({ failed: 1 });
    expect(
      Bun.spawnSync(["docker", "inspect", containerName], { stderr: "ignore" }).exitCode,
    ).not.toBe(0);
    expect(
      Bun.spawnSync(["docker", "inspect", preflightName], { stderr: "ignore" }).exitCode,
    ).not.toBe(0);
  },
  15_000,
);
