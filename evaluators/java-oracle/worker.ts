#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { InfrastructureError, serveEvaluator } from "../shared/protocol.ts";
import type { BuildBackend } from "./backend.ts";
import { createOracleEvaluator } from "./evaluate.ts";
import { FixtureBuildBackend } from "./fixture-backend.ts";
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

export async function loadWorkerConfig(path: string): Promise<{
  config: WorkerConfig;
  directory: string;
}> {
  const resolved = resolve(path);
  const raw = await readFile(resolved, "utf8");
  const parsed = resolved.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  return { config: workerConfigSchema.parse(parsed), directory: dirname(resolved) };
}

/**
 * Opt-in for the fixture backend, which replays recordings and therefore measures nothing.
 *
 * It is an argv flag rather than an environment reference on purpose: argv is recorded verbatim in
 * the evaluator's configuration digest and the journal, environment values are not. A run that
 * measured nothing therefore says so in its own provenance, which is the one thing the backend's
 * design cannot otherwise express — see the note on `configPathFromArgv`.
 */
export const FIXTURE_BACKEND_OPT_IN = "--allow-fixture-backend";

export function fixtureBackendAllowedByArgv(argv: string[]): boolean {
  return argv.includes(FIXTURE_BACKEND_OPT_IN);
}

export function createBackend(
  config: WorkerConfig,
  directory: string,
  environment: Record<string, string | undefined>,
  options: { allowFixtureBackend?: boolean } = {},
): BuildBackend {
  if (config.backend.kind === "fixture") {
    if (options.allowFixtureBackend !== true) {
      throw new InfrastructureError(
        "the fixture backend replays recorded build results and measures nothing, so it must never score a run. " +
          `Point --config at a backend that builds the candidates, or pass ${FIXTURE_BACKEND_OPT_IN} to exercise the evaluator itself.`,
        "evaluator.protocol_error",
      );
    }
    const recordings = isAbsolute(config.backend.recordings)
      ? config.backend.recordings
      : resolve(directory, config.backend.recordings);
    return new FixtureBuildBackend(recordings);
  }
  if (config.backend.kind === "maven") {
    return new MavenBuildBackend(config.backend);
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
    config: config.backend,
    credentials: { username: username as string, password: password as string },
  });
}

/**
 * The backend configuration path is an argv argument rather than an environment reference, because
 * argv is recorded verbatim in the evaluator's configuration digest while environment values are
 * not. Only the credential is an environment reference, because only the credential must stay out
 * of the digest.
 *
 * The digest covers the path, not the file: nothing reads the backend configuration into the
 * evaluator identity, so a fixture run and a live Artemis run whose configurations share a filename
 * are provenance-identical. Point the two at distinct paths, or the journal cannot tell them apart.
 */
export function configPathFromArgv(argv: string[]): string {
  const flag = argv.indexOf("--config");
  const value = flag === -1 ? undefined : argv[flag + 1];
  if (value === undefined) {
    throw new Error("java-oracle requires --config <backend configuration>");
  }
  return value;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const { config, directory } = await loadWorkerConfig(configPathFromArgv(argv));
  const backend = createBackend(config, directory, process.env, {
    allowFixtureBackend: fixtureBackendAllowedByArgv(argv),
  });
  await serveEvaluator(createOracleEvaluator(backend));
}
