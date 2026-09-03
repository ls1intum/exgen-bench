import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { digestJson, sha256 } from "../src/core/canonical.ts";
import {
  loadProcessEvaluatorConfig,
  processEvaluatorConfigSchema,
} from "../src/evaluation/process-config.ts";

const temporaryDirectories: string[] = [];
const originalToken = process.env.EXGEN_TEST_EVALUATOR_TOKEN;
const originalUndeclared = process.env.EXGEN_TEST_UNDECLARED;

function config(overrides: Record<string, unknown> = {}) {
  const digest = "a".repeat(64);
  return {
    schema_version: "1",
    evaluator: {
      id: "fixture-evaluator",
      version: "1",
      revision: "fixture-revision",
      target_profile: "java",
      implementation_digest: digest,
    },
    suite: { id: "fixture-suite", version: "1", digest },
    requested_metrics: ["acceptance"],
    process: {
      argv: ["{bun}", "run", "worker.ts"],
      cwd: "./evaluator",
      env: { EVALUATOR_TOKEN: "EXGEN_TEST_EVALUATOR_TOKEN" },
    },
    execution: {
      timeout_ms: 60_000,
      concurrency: 1,
      maximum_input_bytes: 1_048_576,
      maximum_response_bytes: 16_777_216,
      maximum_log_bytes: 1_048_576,
      termination_grace_ms: 2_000,
    },
    ...overrides,
  };
}

afterEach(async () => {
  if (originalToken === undefined) {
    delete process.env.EXGEN_TEST_EVALUATOR_TOKEN;
  } else {
    process.env.EXGEN_TEST_EVALUATOR_TOKEN = originalToken;
  }
  if (originalUndeclared === undefined) {
    delete process.env.EXGEN_TEST_UNDECLARED;
  } else {
    process.env.EXGEN_TEST_UNDECLARED = originalUndeclared;
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

/**
 * The entry points the config's argv names. `loadProcessEvaluatorConfig` checks that a relative
 * script argument resolves inside the working directory, so a fixture that declares `worker.ts`
 * has to provide one - which is what a real evaluator directory looks like anyway.
 */
async function writeEntryPoints(directory: string): Promise<void> {
  await writeFile(join(directory, "evaluator", "worker.ts"), "export {};\n");
  await writeFile(join(directory, "evaluator", "recover.ts"), "export {};\n");
}

describe("process evaluator config", () => {
  test("names the missing entry point and the directory it was sought in", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-process-config-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "evaluator"));
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify(config()));
    process.env.EXGEN_TEST_EVALUATOR_TOKEN = "fixture-secret";

    // Without this the run discovers the mistake once per candidate, as an infrastructure failure
    // that names neither the file nor the directory.
    await expect(loadProcessEvaluatorConfig(path)).rejects.toThrow(
      /entry point worker\.ts does not exist in its working directory .*evaluator/,
    );
  });

  test("accepts an entry point outside the config directory when cwd points at it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-process-config-"));
    temporaryDirectories.push(directory);
    const elsewhere = await mkdtemp(join(tmpdir(), "exgen-evaluator-tree-"));
    temporaryDirectories.push(elsewhere);
    await writeFile(join(elsewhere, "worker.ts"), "export {};\n");
    const path = join(directory, "config.json");
    const base = config();
    await writeFile(
      path,
      JSON.stringify({ ...base, process: { ...base.process, cwd: elsewhere } }),
    );
    process.env.EXGEN_TEST_EVALUATOR_TOKEN = "fixture-secret";

    // The case this exists for: a config copied out of the evaluator tree to point at another suite.
    const loaded = await loadProcessEvaluatorConfig(path);

    expect(loaded.cwd).toBe(elsewhere);
  });

  test("ignores an interpreter and flags when looking for the entry point", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-process-config-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "evaluator"));
    await writeFile(join(directory, "evaluator", "worker.ts"), "export {};\n");
    const path = join(directory, "config.json");
    const base = config();
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        process: {
          ...base.process,
          argv: ["{bun}", "run", "worker.ts", "--references", "/absent/reference-set.yaml"],
        },
      }),
    );
    process.env.EXGEN_TEST_EVALUATOR_TOKEN = "fixture-secret";

    // `--references` is the evaluator's own argument to validate, not a path this layer can judge.
    await expect(loadProcessEvaluatorConfig(path)).resolves.toBeDefined();
  });

  test("resolves runtime paths and environment references without storing values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-process-config-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "evaluator"));
    await writeEntryPoints(directory);
    const path = join(directory, "config.json");
    const base = config();
    await writeFile(
      path,
      JSON.stringify({
        ...base,
        process: {
          ...base.process,
          recovery: { argv: ["{bun}", "run", "recover.ts"], timeout_ms: 30_000 },
        },
      }),
    );
    process.env.EXGEN_TEST_EVALUATOR_TOKEN = "fixture-secret";

    const loaded = await loadProcessEvaluatorConfig(path);

    expect(loaded.argv[0]).toBe(process.execPath);
    expect(loaded.recovery?.argv[0]).toBe(process.execPath);
    expect(loaded.recovery?.timeoutMs).toBe(30_000);
    expect(loaded.cwd).toBe(join(directory, "evaluator"));
    expect(loaded.environment.EVALUATOR_TOKEN).toBe("fixture-secret");
    expect(JSON.stringify(loaded.config)).not.toContain("fixture-secret");
    expect(loaded.evaluator.configuration_digest).toHaveLength(64);
  });

  test("rejects missing environment references before starting an evaluator", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-process-config-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "evaluator"));
    await writeEntryPoints(directory);
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify(config()));
    delete process.env.EXGEN_TEST_EVALUATOR_TOKEN;

    await expect(loadProcessEvaluatorConfig(path)).rejects.toThrow(
      "requires environment variable EXGEN_TEST_EVALUATOR_TOKEN",
    );
  });

  test("validates a declared digest against the complete secret-free config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-process-config-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "evaluator"));
    await writeEntryPoints(directory);
    process.env.EXGEN_TEST_EVALUATOR_TOKEN = "fixture-secret";
    const path = join(directory, "config.json");
    const base = config();
    const configurationDigest = digestJson(base);
    const value = {
      ...base,
      evaluator: { ...base.evaluator, configuration_digest: configurationDigest },
    };
    await writeFile(path, JSON.stringify(value));

    const loaded = await loadProcessEvaluatorConfig(path);
    expect(loaded.evaluator.configuration_digest).toBe(configurationDigest);

    value.execution.concurrency = 2;
    await writeFile(path, JSON.stringify(value));
    await expect(loadProcessEvaluatorConfig(path)).rejects.toThrow(
      `evaluator configuration digest mismatch: declared ${configurationDigest}, computed `,
    );
  });

  test("never passes an undeclared host variable to the evaluator", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exgen-process-config-"));
    temporaryDirectories.push(directory);
    await mkdir(join(directory, "evaluator"));
    await writeEntryPoints(directory);
    const path = join(directory, "config.json");
    await writeFile(path, JSON.stringify(config()));
    process.env.EXGEN_TEST_EVALUATOR_TOKEN = "fixture-secret";
    process.env.EXGEN_TEST_UNDECLARED = "must-not-leak";

    const loaded = await loadProcessEvaluatorConfig(path);

    expect(loaded.environment.EXGEN_TEST_UNDECLARED).toBeUndefined();
    expect(Object.values(loaded.environment)).not.toContain("must-not-leak");
    expect(Object.keys(loaded.environment).sort()).toEqual(
      ["EVALUATOR_TOKEN", "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]
        .filter((name) => name === "EVALUATOR_TOKEN" || process.env[name] !== undefined)
        .sort(),
    );
  });

  test("rejects execution limits above their declared maxima", async () => {
    expect(
      processEvaluatorConfigSchema.safeParse(
        config({ execution: { ...config().execution, concurrency: 65 } }),
      ).success,
    ).toBe(false);
    expect(
      processEvaluatorConfigSchema.safeParse(
        config({ execution: { ...config().execution, concurrency: 64 } }),
      ).success,
    ).toBe(true);
    expect(
      processEvaluatorConfigSchema.safeParse(
        config({ execution: { ...config().execution, timeout_ms: 24 * 60 * 60 * 1000 + 1 } }),
      ).success,
    ).toBe(false);
    expect(
      processEvaluatorConfigSchema.safeParse(
        config({
          execution: { ...config().execution, maximum_response_bytes: 1024 * 1024 * 1024 + 1 },
        }),
      ).success,
    ).toBe(false);
    expect(
      processEvaluatorConfigSchema.safeParse(
        config({
          execution: { ...config().execution, termination_grace_ms: 5 * 60 * 1000 + 1 },
        }),
      ).success,
    ).toBe(false);
  });

  test("keeps the published example digests equal to the files they pin", async () => {
    const example = processEvaluatorConfigSchema.parse(
      parse(await readFile(resolve("examples/process-evaluator/config.yaml"), "utf8")),
    );

    expect(example.evaluator.implementation_digest).toBe(
      sha256(await readFile(resolve("examples/process-evaluator/worker.ts"))),
    );
    expect(example.suite.digest).toBe(
      sha256(await readFile(resolve("examples/process-evaluator/SUITE.md"))),
    );
  });
});
