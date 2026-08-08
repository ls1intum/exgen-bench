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

const fixtureBackendConfigSchema = z
  .object({
    kind: z.literal("fixture"),
    recordings: z.string().min(1),
  })
  .strict();

const backendConfigSchema = z.discriminatedUnion("kind", [
  fixtureBackendConfigSchema,
  localCiBackendConfigSchema,
]);

const workerConfigSchema = z
  .object({
    schema_version: z.literal("1"),
    backend: backendConfigSchema,
    /**
     * The *name* of the host environment variable holding the Artemis credential, never the
     * credential, so nothing secret enters the configuration digest or the journal.
     */
    authorization_env: z.string().min(1).default("ARTEMIS_AUTHORIZATION"),
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

export function createBackend(
  config: WorkerConfig,
  directory: string,
  environment: Record<string, string | undefined>,
): BuildBackend {
  if (config.backend.kind === "fixture") {
    const recordings = isAbsolute(config.backend.recordings)
      ? config.backend.recordings
      : resolve(directory, config.backend.recordings);
    return new FixtureBuildBackend(recordings);
  }
  const authorization = environment[config.authorization_env];
  if (authorization === undefined || authorization.length === 0) {
    throw new InfrastructureError(
      `the LocalCI backend requires a credential in ${config.authorization_env}`,
    );
  }
  return new LocalCiBuildBackend({ config: config.backend, authorization });
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
  const { config, directory } = await loadWorkerConfig(configPathFromArgv(process.argv.slice(2)));
  const backend = createBackend(config, directory, process.env);
  await serveEvaluator(createOracleEvaluator(backend));
}
