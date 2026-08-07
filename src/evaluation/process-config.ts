import { lstat, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { digestJson } from "../core/canonical.ts";
import { resolveRuntimeCommand } from "../core/runtime.ts";
import {
  type EvaluatorIdentity,
  evaluationIdentifierSchema,
  evaluationSuiteSchema,
  evaluatorIdentitySchema,
} from "./contracts.ts";

export const PROCESS_EVALUATOR_CONFIG_VERSION = "1" as const;

export const MAXIMUM_CONCURRENCY = 64;
export const MAXIMUM_TIMEOUT_MS = 24 * 60 * 60 * 1000;
export const MAXIMUM_TERMINATION_GRACE_MS = 5 * 60 * 1000;
export const MAXIMUM_STREAM_BYTES = 1024 * 1024 * 1024;

const boundedInteger = (maximum: number) => z.int().positive().max(maximum);
const argvSchema = z.array(z.string().min(1)).min(1);
const environmentNameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const processEvaluatorConfigSchema = z.strictObject({
  schema_version: z.literal(PROCESS_EVALUATOR_CONFIG_VERSION),
  evaluator: evaluatorIdentitySchema.extend({
    configuration_digest: evaluatorIdentitySchema.shape.configuration_digest.describe(
      "SHA-256 digest of this complete secret-free configuration. Optional; when present exgen recomputes it and refuses to run on a mismatch.",
    ),
  }),
  suite: evaluationSuiteSchema,
  requested_metrics: z
    .array(evaluationIdentifierSchema)
    .min(1)
    .refine((metrics) => new Set(metrics).size === metrics.length, {
      message: "requested metric IDs must be unique",
    })
    .meta({ uniqueItems: true })
    .describe(
      "Metric IDs this evaluator is asked to report; every ID must be declared by the suite and appear at most once.",
    ),
  process: z.strictObject({
    argv: argvSchema,
    cwd: z.string().min(1),
    env: z
      .record(environmentNameSchema, environmentNameSchema)
      .describe(
        "Mapping from the child environment-variable name to the host environment-variable NAME whose value is passed through. Values are variable names, never secrets; secret values are read at launch and never stored, digested, or journalled.",
      ),
    recovery: z
      .strictObject({
        argv: argvSchema,
        timeout_ms: boundedInteger(MAXIMUM_TIMEOUT_MS),
      })
      .optional(),
  }),
  execution: z.strictObject({
    timeout_ms: boundedInteger(MAXIMUM_TIMEOUT_MS),
    concurrency: boundedInteger(MAXIMUM_CONCURRENCY),
    maximum_input_bytes: boundedInteger(MAXIMUM_STREAM_BYTES),
    maximum_response_bytes: boundedInteger(MAXIMUM_STREAM_BYTES),
    maximum_log_bytes: boundedInteger(MAXIMUM_STREAM_BYTES),
    termination_grace_ms: boundedInteger(MAXIMUM_TERMINATION_GRACE_MS).describe(
      "Milliseconds an evaluator process may keep running after SIGTERM before it is killed with SIGKILL.",
    ),
  }),
});

export type ProcessEvaluatorConfig = z.infer<typeof processEvaluatorConfigSchema>;

export interface LoadedProcessEvaluatorConfig {
  config: ProcessEvaluatorConfig;
  configPath: string;
  configDirectory: string;
  evaluator: EvaluatorIdentity;
  argv: [string, ...string[]];
  cwd: string;
  environment: Record<string, string>;
  recovery?: {
    argv: [string, ...string[]];
    timeoutMs: number;
  };
}

// This is an allowlist, not a filter: only the names below and the declared mapping reach the
// evaluator, so never spread process.env into the result.
function baseEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"]) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function resolveEnvironment(references: Record<string, string>): Record<string, string> {
  const environment = baseEnvironment();
  for (const [targetName, sourceName] of Object.entries(references)) {
    const value = process.env[sourceName];
    if (value === undefined) {
      throw new Error(`evaluator requires environment variable ${sourceName} for ${targetName}`);
    }
    environment[targetName] = value;
  }
  return environment;
}

function command(argv: string[]): [string, ...string[]] {
  const resolved = resolveRuntimeCommand(argv);
  const executable = resolved[0];
  if (executable === undefined) {
    throw new Error("evaluation process command cannot be empty");
  }
  return [executable, ...resolved.slice(1)];
}

async function readStructuredFile(path: string): Promise<unknown> {
  const source = await readFile(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(source) : parse(source);
}

function configuredEvaluator(config: ProcessEvaluatorConfig): EvaluatorIdentity {
  const { configuration_digest: declaredDigest, ...baseIdentity } = config.evaluator;
  const configurationDigest = digestJson({
    ...config,
    evaluator: baseIdentity,
  });
  if (declaredDigest !== undefined && declaredDigest !== configurationDigest) {
    throw new Error(
      `evaluator configuration digest mismatch: declared ${declaredDigest}, computed ${configurationDigest}`,
    );
  }
  return { ...baseIdentity, configuration_digest: configurationDigest };
}

/**
 * The digest pins the identity every record in the file was produced under, so a changed
 * configuration writes a new journal instead of appending to an incomparable one.
 */
export function processEvaluationJournalPath(
  runDirectory: string,
  loaded: Pick<LoadedProcessEvaluatorConfig, "evaluator" | "config">,
): string {
  const identity = digestJson({
    evaluator: loaded.evaluator,
    suite: loaded.config.suite,
    requested_metrics: loaded.config.requested_metrics,
    timeout_ms: loaded.config.execution.timeout_ms,
  }).slice(0, 12);
  return join(
    runDirectory,
    "evaluations",
    `${loaded.evaluator.id}-${loaded.config.suite.id}-${identity}.jsonl`,
  );
}

export async function loadProcessEvaluatorConfig(
  configPathInput: string,
): Promise<LoadedProcessEvaluatorConfig> {
  const configPath = resolve(configPathInput);
  const configDirectory = dirname(configPath);
  const config = processEvaluatorConfigSchema.parse(await readStructuredFile(configPath));
  const cwd = resolve(configDirectory, config.process.cwd);
  const cwdMetadata = await lstat(cwd);
  if (cwdMetadata.isSymbolicLink() || !cwdMetadata.isDirectory()) {
    throw new Error(`evaluator working directory must be a real directory, not a link: ${cwd}`);
  }

  return {
    config,
    configPath,
    configDirectory,
    evaluator: configuredEvaluator(config),
    argv: command(config.process.argv),
    cwd,
    environment: resolveEnvironment(config.process.env),
    ...(config.process.recovery
      ? {
          recovery: {
            argv: command(config.process.recovery.argv),
            timeoutMs: config.process.recovery.timeout_ms,
          },
        }
      : {}),
  };
}
