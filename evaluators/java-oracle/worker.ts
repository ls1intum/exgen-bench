#!/usr/bin/env bun

import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { digestJson } from "../../src/core/canonical.ts";
import { readTextBounded } from "../../src/core/files.ts";
import { InfrastructureError, serveEvaluator, serveRecovery } from "../shared/protocol.ts";
import type { BuildBackend } from "./backend.ts";
import { createOracleEvaluator, createOracleRecovery } from "./evaluate.ts";
import { FixtureBuildBackend } from "./fixture-backend.ts";
import { GradleBuildBackend, gradleBackendConfigSchema } from "./gradle-backend.ts";
import { LocalCiBuildBackend, localCiBackendConfigSchema } from "./localci-backend.ts";
import { MavenBuildBackend, mavenBackendConfigSchema } from "./maven-backend.ts";

const fixtureBackendConfigSchema = z
  .object({
    kind: z.literal("fixture"),
    recordings: z.string().min(1),
  })
  .strict();

const backendConfigSchema = z.discriminatedUnion("kind", [
  fixtureBackendConfigSchema,
  gradleBackendConfigSchema,
  mavenBackendConfigSchema,
  localCiBackendConfigSchema,
]);

const workerConfigSchema = z
  .object({
    schema_version: z.literal("1"),
    backend: backendConfigSchema,
    /**
     * The *names* of the host environment variables holding the evaluation-course credential, never
     * the credential itself, so nothing secret enters the configuration digest or the journal.
     *
     * Artemis authenticates a username and password and answers with a session cookie; there is no
     * bearer token to configure. Two names rather than one keeps the password out of any value that
     * might reasonably be logged as an identity.
     */
    username_env: z.string().min(1).default("ARTEMIS_EVALUATION_USERNAME"),
    password_env: z.string().min(1).default("ARTEMIS_EVALUATION_PASSWORD"),
  })
  .strict();

export type WorkerConfig = z.infer<typeof workerConfigSchema>;
const MAXIMUM_CONFIG_BYTES = 1024 * 1024;

export function workerConfigDigest(config: WorkerConfig): string {
  return digestJson(config);
}

export async function loadWorkerConfig(path: string): Promise<{
  config: WorkerConfig;
  directory: string;
}> {
  const resolved = resolve(path);
  const raw = await readTextBounded(resolved, MAXIMUM_CONFIG_BYTES);
  const parsed = resolved.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  return { config: workerConfigSchema.parse(parsed), directory: dirname(resolved) };
}

export function resolveBackendConfig(
  config: WorkerConfig["backend"],
  directory: string,
): WorkerConfig["backend"] {
  if (config.kind === "fixture") {
    return {
      ...config,
      recordings: isAbsolute(config.recordings)
        ? config.recordings
        : resolve(directory, config.recordings),
    };
  }
  if (config.kind === "maven") {
    return {
      ...config,
      ...(config.local_repository === undefined
        ? {}
        : { local_repository: resolve(directory, config.local_repository) }),
      ...(config.java_home === undefined
        ? {}
        : { java_home: resolve(directory, config.java_home) }),
      ...(config.work_directory === undefined
        ? {}
        : { work_directory: resolve(directory, config.work_directory) }),
    };
  }
  if (config.kind === "gradle") {
    return {
      ...config,
      ...(config.user_home === undefined
        ? {}
        : { user_home: resolve(directory, config.user_home) }),
      ...(config.java_home === undefined
        ? {}
        : { java_home: resolve(directory, config.java_home) }),
      ...(config.work_directory === undefined
        ? {}
        : { work_directory: resolve(directory, config.work_directory) }),
    };
  }
  return config;
}

export const FIXTURE_BACKEND_OPT_IN = "--allow-fixture-backend";

export const RECOVER_FLAG = "--recover";

export function recoverModeFromArgv(argv: string[]): boolean {
  return argv.includes(RECOVER_FLAG);
}

export function fixtureBackendAllowedByArgv(argv: string[]): boolean {
  return argv.includes(FIXTURE_BACKEND_OPT_IN);
}

export function createBackend(
  config: WorkerConfig,
  directory: string,
  environment: Record<string, string | undefined>,
  options: { allowFixtureBackend?: boolean } = {},
): BuildBackend {
  const backend = resolveBackendConfig(config.backend, directory);
  if (backend.kind === "fixture") {
    if (options.allowFixtureBackend !== true) {
      throw new InfrastructureError(
        "the fixture backend replays recorded build results and measures nothing, so it must never score a run. " +
          `Point --config at a backend that builds the candidates, or pass ${FIXTURE_BACKEND_OPT_IN} to exercise the evaluator itself.`,
        "evaluator.protocol_error",
      );
    }
    return new FixtureBuildBackend(backend.recordings);
  }
  if (backend.kind === "maven") {
    return new MavenBuildBackend(backend);
  }
  if (backend.kind === "gradle") {
    return new GradleBuildBackend(backend);
  }
  const username = environment[config.username_env];
  const password = environment[config.password_env];
  const missing = [
    ...(username === undefined || username.length === 0 ? [config.username_env] : []),
    ...(password === undefined || password.length === 0 ? [config.password_env] : []),
  ];
  if (missing.length > 0) {
    // Names only: the message reaches logs, so it must never carry a value.
    throw new InfrastructureError(
      `the LocalCI backend requires a credential in ${missing.join(" and ")}`,
    );
  }
  return new LocalCiBuildBackend({
    config: backend,
    credentials: { username: username as string, password: password as string },
  });
}

export function configPathFromArgv(argv: string[]): string {
  const flag = argv.indexOf("--config");
  const value = flag === -1 ? undefined : argv[flag + 1];
  if (value === undefined) {
    throw new Error("java-oracle requires --config <backend configuration>");
  }
  return value;
}

export function configDigestFromArgv(argv: string[]): string {
  const flag = argv.indexOf("--config-digest");
  const value = flag === -1 ? undefined : argv[flag + 1];
  if (value === undefined || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("java-oracle requires --config-digest <sha256>");
  }
  return value;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const { config, directory } = await loadWorkerConfig(configPathFromArgv(argv));
  if (argv.includes("--print-config-digest")) {
    process.stdout.write(`${workerConfigDigest(config)}\n`);
    process.exit(0);
  }
  const expectedDigest = configDigestFromArgv(argv);
  const observedDigest = workerConfigDigest(config);
  if (observedDigest !== expectedDigest) {
    throw new Error(
      `java-oracle backend configuration digest mismatch: expected ${expectedDigest}, observed ${observedDigest}`,
    );
  }
  const backend = createBackend(config, directory, process.env, {
    allowFixtureBackend: fixtureBackendAllowedByArgv(argv),
  });
  if (recoverModeFromArgv(argv)) {
    await serveRecovery(createOracleRecovery(backend));
  } else {
    await serveEvaluator(createOracleEvaluator(backend));
  }
}
