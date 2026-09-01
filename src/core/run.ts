import { Database } from "bun:sqlite";
import { lstat, mkdir, readdir, readlink, rename, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import Ajv2020, { type AnySchema, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import PQueue from "p-queue";
import { validateAndDigestArtifacts } from "../adapters/artifacts.ts";
import { validateDiagnostics } from "../adapters/diagnostics.ts";
import {
  type BudgetDimension,
  type FactorScalar,
  type LimitSource,
  GENERATION_PROTOCOL_VERSION,
  type GenerationRequest,
  type GenerationResponse,
  type GeneratorDescriptor,
  generationRequestSchema,
  generationResponseSchema,
  generatorDescriptorSchema,
  type System,
} from "../contracts.ts";
import { digestJson, sha256 } from "./canonical.ts";
import { buildEvidenceManifest, sha256File, writeEvidenceManifest } from "./evidence.ts";
import { readTextBounded, writeJsonAtomic } from "./files.ts";
import { type AttemptRow, Ledger } from "./ledger.ts";
import type { LoadedBenchmark } from "./load.ts";
import type { ExperimentPlan, PlannedAttempt } from "./plan.ts";
import { OpenRouterReferencePricing } from "../pricing/openrouter.ts";
import { supervisedCommand, supervisedEnvironment } from "./process-supervision.ts";
import { createRuntimeInvocation } from "./runtime.ts";

export interface RunManifest {
  schema_version: "1";
  run_id: string;
  run_instance_id: string;
  created_at: string;
  plan: ExperimentPlan;
  provenance: {
    exgen_revision: string | null;
    exgen_dirty: boolean | null;
    exgen_source_tree_sha256: string | null;
    bun_version: string;
    bun_revision: string;
    operating_system: NodeJS.Platform;
    architecture: string;
    lockfile_sha256: string | null;
    generator_descriptors: GeneratorDescriptor[];
  };
}

export interface RunSummary {
  runId: string;
  directory: string;
  total: number;
  counts: Record<string, number>;
  interrupted: boolean;
}

interface StoredManifest {
  run_id?: unknown;
  run_instance_id?: unknown;
  plan?: { id?: unknown };
  provenance?: { generator_descriptors?: unknown };
}

const HANDSHAKE_STREAM_MAXIMUM_BYTES = 1024 * 1024;
const REQUEST_MAXIMUM_BYTES = 16 * 1024 * 1024;
const RESPONSE_MAXIMUM_BYTES = 16 * 1024 * 1024;
const OBSERVATION_MAXIMUM_BYTES = 32 * 1024 * 1024;
const EVIDENCE_MANIFEST_MAXIMUM_BYTES = 128 * 1024 * 1024;
const SUBPROCESS_TERMINATION_GRACE_MS = 2_000;
const CONTAINER_CLEANUP_TIMEOUT_MS = 5_000;
const CRASH_RECOVERY_TIMEOUT_MS = 60_000;

class RemoteRecoveryPendingError extends Error {}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

export async function acquireRunCoordinatorLock(
  runDirectory: string,
): Promise<() => Promise<void>> {
  const database = new Database(join(runDirectory, ".coordinator.sqlite"), {
    create: true,
    strict: true,
  });
  database.run("PRAGMA busy_timeout = 0");
  try {
    database.run("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (
      errorCode(error) === "SQLITE_BUSY" ||
      (error instanceof Error && error.message.includes("database is locked"))
    ) {
      throw new Error(`run is already owned by another coordinator: ${runDirectory}`);
    }
    throw error;
  }
  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    try {
      database.run("COMMIT");
    } finally {
      database.close();
    }
  };
}

async function captureBoundedStream(
  stream: ReadableStream<Uint8Array>,
  path: string,
  maximumBytes: number,
  onLimit: () => void,
): Promise<void> {
  const sink = Bun.file(path).writer();
  let written = 0;
  try {
    for await (const chunk of stream) {
      const remaining = maximumBytes - written;
      if (remaining <= 0) {
        onLimit();
        continue;
      }
      const accepted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
      sink.write(accepted);
      written += accepted.byteLength;
      if (accepted.byteLength < chunk.byteLength) {
        onLimit();
      }
    }
  } finally {
    sink.end();
  }
}

async function captureBoundedText(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  onLimit: () => void,
): Promise<string> {
  const chunks: Uint8Array[] = [];
  let captured = 0;
  let exceeded = false;
  for await (const chunk of stream) {
    const remaining = maximumBytes - captured;
    if (remaining <= 0) {
      exceeded = true;
      onLimit();
      continue;
    }
    const accepted = chunk.byteLength <= remaining ? chunk : chunk.subarray(0, remaining);
    chunks.push(accepted);
    captured += accepted.byteLength;
    if (accepted.byteLength < chunk.byteLength) {
      exceeded = true;
      onLimit();
    }
  }
  if (exceeded) {
    throw new Error(`stream exceeds ${maximumBytes} bytes`);
  }
  const bytes = new Uint8Array(captured);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function waitForSubprocessExit(
  subprocess: {
    exited: Promise<number>;
    kill(signal?: number | NodeJS.Signals): void;
  },
  signal: AbortSignal,
  forceCleanup?: () => Promise<void>,
): Promise<number> {
  let escalation: Promise<void> | undefined;
  const forceKill = (): void => {
    if (escalation !== undefined) {
      return;
    }
    escalation = (async () => {
      await Bun.sleep(SUBPROCESS_TERMINATION_GRACE_MS);
      try {
        await forceCleanup?.();
      } finally {
        try {
          subprocess.kill("SIGKILL");
        } catch {}
      }
    })();
  };
  if (signal.aborted) {
    forceKill();
  } else {
    signal.addEventListener("abort", forceKill, { once: true });
  }
  try {
    return await subprocess.exited;
  } finally {
    signal.removeEventListener("abort", forceKill);
    if (escalation !== undefined) {
      await escalation;
    }
  }
}

function containerNotFound(engine: "docker" | "podman", stderr: string): boolean {
  const message = stderr.trim();
  return engine === "docker"
    ? /^Error response from daemon: No such container: [A-Za-z0-9][A-Za-z0-9_.-]*$/.test(message)
    : /^Error: no container with name or ID "[A-Za-z0-9][A-Za-z0-9_.-]*" found: no such container$/.test(
        message,
      );
}

async function forceRemoveContainer(system: System, name: string): Promise<void> {
  if (system.runtime.type !== "container") {
    return;
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("container cleanup timed out")),
    CONTAINER_CLEANUP_TIMEOUT_MS,
  );
  try {
    const cleanup = Bun.spawn([system.runtime.engine, "rm", "--force", name], {
      cwd: process.cwd(),
      env: baseEnvironment(),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      signal: controller.signal,
      killSignal: "SIGKILL",
    });
    const [exitCode, stderr] = await Promise.all([
      cleanup.exited,
      captureBoundedText(cleanup.stderr, HANDSHAKE_STREAM_MAXIMUM_BYTES, () => {
        controller.abort(new Error("container cleanup output exceeded configured limit"));
      }),
    ]);
    if (exitCode !== 0 && !containerNotFound(system.runtime.engine, stderr)) {
      throw new Error(
        `${system.runtime.engine} could not remove container ${name} (${exitCode}): ${stderr.trim()}`,
      );
    }
  } finally {
    clearTimeout(timeout);
  }
}

function attemptContainerName(runInstanceId: string, attemptId: string): string {
  return `exgen-attempt-${sha256(`${runInstanceId}\0${attemptId}`).slice(0, 32)}`;
}

function recoveryContainerName(runInstanceId: string, attemptId: string): string {
  return `exgen-recovery-${sha256(`${runInstanceId}\0${attemptId}`).slice(0, 32)}`;
}

export type BudgetStatus = "compliant" | "exceeded" | "unverifiable" | "non_binding";

export interface BudgetDimensionAssessment {
  dimension: BudgetDimension;
  status: BudgetStatus;
  declared_limit: number | null;
  observed: number | null;
  system_limit: number | null;
  system_limit_source: LimitSource | null;
  enforcement: "harness" | "system" | null;
}

type ReportedLimit = { value: number; source?: LimitSource };

function reportedLimit(
  limit: number | { value: number; source: LimitSource } | undefined,
): ReportedLimit | undefined {
  if (limit === undefined) {
    return undefined;
  }
  return typeof limit === "number"
    ? { value: limit }
    : { value: limit.value, source: limit.source };
}

export interface BudgetAssessment {
  status: BudgetStatus;
  violations: string[];
  missing: string[];
  dimensions: BudgetDimensionAssessment[];
}

const BUDGET_STATUS_SEVERITY: Record<BudgetStatus, number> = {
  compliant: 0,
  non_binding: 1,
  unverifiable: 2,
  exceeded: 3,
};

function assessBudget(
  response: GenerationResponse | undefined,
  budget: ExperimentPlan["budget"],
  wall: { durationMs?: number | undefined; timedOut: boolean },
): BudgetAssessment {
  const violations: string[] = [];
  const missing: string[] = [];
  const usage = response?.usage;
  const cost = response?.cost;
  const systemLimits = response?.execution?.effective_limits;
  const costCurrencyMatches =
    budget.max_cost !== undefined && cost !== undefined
      ? cost.currency === budget.max_cost.currency
      : undefined;
  const systemCost = systemLimits?.cost;
  const systemCostLimit =
    budget.max_cost !== undefined && systemCost?.currency === budget.max_cost.currency
      ? {
          value: systemCost.amount,
          ...("source" in systemCost ? { source: systemCost.source } : {}),
        }
      : undefined;
  const checks: Array<
    [BudgetDimension, number | undefined, number | undefined, ReportedLimit | undefined]
  > = [
    [
      "wall_time_ms",
      wall.durationMs,
      budget.wall_time_ms,
      reportedLimit(systemLimits?.wall_time_ms),
    ],
    [
      "model_calls",
      usage?.model_calls,
      budget.max_model_calls,
      reportedLimit(systemLimits?.model_calls),
    ],
    [
      "tool_calls",
      usage?.tool_calls,
      budget.max_tool_calls,
      reportedLimit(systemLimits?.tool_calls),
    ],
    [
      "input_tokens",
      usage?.input_tokens,
      budget.max_input_tokens,
      reportedLimit(systemLimits?.input_tokens),
    ],
    [
      "output_tokens",
      usage?.output_tokens,
      budget.max_output_tokens,
      reportedLimit(systemLimits?.output_tokens),
    ],
    [
      "total_tokens",
      usage?.total_tokens,
      budget.max_total_tokens,
      reportedLimit(systemLimits?.total_tokens),
    ],
    ["cost", cost?.amount, budget.max_cost?.amount, systemCostLimit],
  ];

  const dimensions = checks.map(
    ([dimension, observed, declared, systemLimit]): BudgetDimensionAssessment => {
      const shared = {
        dimension,
        declared_limit: declared ?? null,
        observed: observed ?? null,
        system_limit: systemLimit?.value ?? null,
        system_limit_source: systemLimit?.source ?? null,
        enforcement: budget.enforcement[dimension] ?? null,
      };
      if (declared === undefined) {
        // A dimension nobody bounded and nothing consumed did not constrain this run, and saying it
        // could not be verified would be a claim about spending that never happened. The system
        // under test decides what it reports: a model with no configured price reports no cost at
        // all, and treating that as unverifiable makes the strict estimand unattainable for every
        // attempt rather than describing anything about the run.
        if (observed === undefined) {
          return { ...shared, status: "non_binding" };
        }
        // Consumption without a declared ceiling is the case that genuinely cannot be verified.
        missing.push(`${dimension}:undeclared`);
        return { ...shared, status: "unverifiable" };
      }
      if (dimension === "cost" && costCurrencyMatches === false) {
        missing.push(`cost_currency:${cost?.currency}`);
        return { ...shared, status: "unverifiable" };
      }
      if (observed === undefined) {
        missing.push(dimension);
        return { ...shared, status: "unverifiable" };
      }
      if (observed > declared || (dimension === "wall_time_ms" && wall.timedOut)) {
        violations.push(`${dimension}:${Math.round(observed)}>${declared}`);
        return { ...shared, status: "exceeded" };
      }
      if (
        systemLimit !== undefined &&
        systemLimit.source === "system_reported" &&
        systemLimit.value <= declared
      ) {
        return { ...shared, status: "non_binding" };
      }
      return { ...shared, status: "compliant" };
    },
  );

  const status = dimensions.reduce<BudgetStatus>(
    (worst, dimension) =>
      BUDGET_STATUS_SEVERITY[dimension.status] > BUDGET_STATUS_SEVERITY[worst]
        ? dimension.status
        : worst,
    "compliant",
  );
  return { status, violations, missing, dimensions };
}

function gitOutput(arguments_: string[]): string | null {
  const result = Bun.spawnSync(["git", ...arguments_], {
    cwd: resolve(import.meta.dir, "../.."),
    stderr: "ignore",
    stdout: "pipe",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

async function lockfileDigest(): Promise<string | null> {
  const lockPath = resolve(import.meta.dir, "../..", "bun.lock");
  const lockFile = Bun.file(lockPath);
  return (await lockFile.exists()) ? sha256(new Uint8Array(await lockFile.arrayBuffer())) : null;
}

export async function untrackedSourceEntry(
  repository: string,
  path: string,
): Promise<
  | { path: string; symlink: string }
  | { path: string; sha256: string }
  | { path: string; embedded_repository: true }
> {
  const absolute = resolve(repository, path);
  const metadata = await lstat(absolute);
  if (metadata.isSymbolicLink()) {
    return { path, symlink: await readlink(absolute) };
  }
  if (metadata.isDirectory()) {
    return { path, embedded_repository: true };
  }
  return { path, sha256: await sha256File(absolute) };
}

async function sourceTreeDigest(): Promise<string | null> {
  const revision = gitOutput(["rev-parse", "HEAD"]);
  const patch = gitOutput(["diff", "--binary", "HEAD"]);
  const untrackedOutput = gitOutput(["ls-files", "--others", "--exclude-standard"]);
  if (revision === null || patch === null || untrackedOutput === null) {
    return null;
  }
  const repository = resolve(import.meta.dir, "../..");
  const untracked = await Promise.all(
    untrackedOutput
      .split("\n")
      .filter(Boolean)
      .sort()
      .map((path) => untrackedSourceEntry(repository, path)),
  );
  return digestJson({
    revision,
    patch_sha256: sha256(patch),
    untracked,
  });
}

export async function createRunManifest(
  runId: string,
  plan: ExperimentPlan,
  generatorDescriptors: GeneratorDescriptor[],
): Promise<RunManifest> {
  const status = gitOutput(["status", "--porcelain"]);
  return {
    schema_version: "1",
    run_id: runId,
    run_instance_id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    plan,
    provenance: {
      exgen_revision: gitOutput(["rev-parse", "HEAD"]),
      exgen_dirty: status === null ? null : status.length > 0,
      exgen_source_tree_sha256: await sourceTreeDigest(),
      bun_version: Bun.version,
      bun_revision: Bun.revision,
      operating_system: process.platform,
      architecture: process.arch,
      lockfile_sha256: await lockfileDigest(),
      generator_descriptors: generatorDescriptors,
    },
  };
}

function baseEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "WINDIR",
  ]) {
    const value = process.env[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

function resolveEnvironment(system: System, includeDeclaredSecrets = true): Record<string, string> {
  const environment = baseEnvironment();
  if (!includeDeclaredSecrets) {
    return environment;
  }
  for (const [targetName, sourceName] of Object.entries(system.runtime.env)) {
    const value = process.env[sourceName];
    if (value === undefined) {
      throw new Error(
        `system ${system.id} requires environment variable ${sourceName} for ${targetName}`,
      );
    }
    environment[targetName] = value;
  }
  return environment;
}

function runtimeEnvironment(system: System, includeDeclaredSecrets = true): Record<string, string> {
  const environment = resolveEnvironment(system, includeDeclaredSecrets);
  return system.runtime.type === "command" ? supervisedEnvironment(environment) : environment;
}

function runtimeCommand(system: System, argv: string[]): string[] {
  return system.runtime.type === "command" ? supervisedCommand(argv) : argv;
}

function validateDeclaredParameters(system: System, schema: Record<string, unknown>): void {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  let validate: ValidateFunction;
  try {
    validate = ajv.compile(schema as AnySchema);
  } catch (error) {
    throw new Error(
      `system ${system.id} declared an invalid parameters_schema: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!validate(system.parameters)) {
    throw new Error(
      `system ${system.id} parameters do not satisfy the declared parameters schema: ${ajv.errorsText(
        validate.errors,
        { dataVar: "parameters", separator: "; " },
      )}`,
    );
  }
}

export async function preflightSystems(
  loaded: LoadedBenchmark,
  plan: ExperimentPlan,
  containerNamespace: string = crypto.randomUUID(),
): Promise<GeneratorDescriptor[]> {
  const descriptors: GeneratorDescriptor[] = [];
  for (const system of plan.systems) {
    resolveEnvironment(system);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("handshake timed out")), 15_000);
    let exitCode: number;
    let stdout: string;
    let stderr: string;
    try {
      const containerName = `exgen-preflight-${sha256(`${containerNamespace}\0${system.id}`).slice(
        0,
        32,
      )}`;
      if (system.runtime.type === "container") {
        await forceRemoveContainer(system, containerName);
      }
      const invocation = createRuntimeInvocation(system, {
        configDirectory: loaded.configDirectory,
        arguments: ["describe", "--json"],
        ...(system.runtime.type === "container" ? { containerName } : {}),
        includeDeclaredEnvironment: true,
      });
      const subprocess = Bun.spawn(runtimeCommand(system, invocation.argv), {
        cwd: invocation.cwd,
        env: runtimeEnvironment(system),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
        killSignal: "SIGTERM",
      });
      const onHandshakeLimit = (): void => {
        controller.abort(new Error("capability handshake output exceeded configured limit"));
      };
      [exitCode, stdout, stderr] = await Promise.all([
        waitForSubprocessExit(
          subprocess,
          controller.signal,
          system.runtime.type === "container"
            ? () => forceRemoveContainer(system, containerName)
            : undefined,
        ),
        captureBoundedText(subprocess.stdout, HANDSHAKE_STREAM_MAXIMUM_BYTES, onHandshakeLimit),
        captureBoundedText(subprocess.stderr, HANDSHAKE_STREAM_MAXIMUM_BYTES, onHandshakeLimit),
      ]);
    } catch (error) {
      throw new Error(
        `system ${system.id} capability handshake failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      clearTimeout(timeout);
    }
    if (exitCode !== 0) {
      throw new Error(
        `system ${system.id} capability handshake failed (${exitCode}): ${stderr.trim()}`,
      );
    }
    const descriptor = generatorDescriptorSchema.parse(JSON.parse(stdout));
    if (
      descriptor.id !== system.id ||
      descriptor.version !== system.version ||
      descriptor.revision !== system.revision
    ) {
      throw new Error(
        `system ${system.id} descriptor does not match configured id/version/revision`,
      );
    }
    if (!descriptor.capabilities.targets.includes(plan.target.id)) {
      throw new Error(`system ${system.id} does not declare target ${plan.target.id}`);
    }
    const unenforceable = Object.entries(plan.budget.enforcement)
      .filter(
        ([dimension, enforcement]) =>
          enforcement === "harness" &&
          !(descriptor.capabilities.budget_dimensions ?? []).includes(dimension as BudgetDimension),
      )
      .map(([dimension]) => dimension);
    if (unenforceable.length > 0) {
      throw new Error(
        `system ${system.id} cannot enforce budget dimensions declared as harness-enforced: ${unenforceable
          .sort()
          .join(", ")}`,
      );
    }
    for (const [control, declared] of [
      ["requested", descriptor.capabilities.controls ?? []],
      ["observed", descriptor.capabilities.observes ?? []],
    ] as const) {
      const inapplicable = Object.entries(system.factors)
        .filter(([name, factor]) => factor.control === control && !declared.includes(name))
        .map(([name]) => name)
        .sort();
      if (inapplicable.length > 0) {
        throw new Error(
          `system ${system.id} declares ${control} factor(s) ${inapplicable.join(", ")} that the adapter does not ${
            control === "requested" ? "control" : "observe"
          } (it declares ${declared.length === 0 ? "none" : [...declared].sort().join(", ")})`,
        );
      }
    }
    if (descriptor.parameters_schema) {
      validateDeclaredParameters(system, descriptor.parameters_schema);
    }
    descriptors.push(descriptor);
  }
  return descriptors;
}

function requestedFactors(system: System): Record<string, FactorScalar> {
  return Object.fromEntries(
    Object.entries(system.factors)
      .filter(([, factor]) => factor.control === "requested")
      .map(([name, factor]) => [name, factor.value]),
  );
}

function factorDisagreements(system: System, response: GenerationResponse): string[] {
  const reported = response.execution?.observed_factors;
  return Object.entries(system.factors)
    .filter(([, factor]) => factor.control !== "declared")
    .flatMap(([name, factor]) => {
      if (reported === undefined || !Object.hasOwn(reported, name)) {
        return [`${name} (${factor.control}) was not reported by the system`];
      }
      return reported[name] === factor.value
        ? []
        : [
            `${name} declared ${JSON.stringify(factor.value)}, system reported ${JSON.stringify(reported[name])}`,
          ];
    });
}

function seedDisagreement(
  descriptor: GeneratorDescriptor,
  response: GenerationResponse,
): string | undefined {
  const declared = descriptor.capabilities.seed;
  const reported = response.execution?.seed_status;
  if (reported === undefined) {
    return undefined;
  }
  if (declared === "unsupported" && reported !== "unsupported") {
    return `capability seed=unsupported contradicts reported seed_status=${reported}`;
  }
  if (declared !== "unsupported" && reported === "unsupported") {
    return `capability seed=${declared} contradicts reported seed_status=unsupported`;
  }
  if (declared === "deterministic" && reported !== "honored") {
    return `capability seed=deterministic contradicts reported seed_status=${reported}`;
  }
  return undefined;
}

function systemConfigurationDigest(response: GenerationResponse): string | undefined {
  if (response.status !== "succeeded") {
    return undefined;
  }
  const execution = response.execution;
  return execution === undefined
    ? undefined
    : digestJson({
        model: response.model ?? null,
        effective_parameters: execution.effective_parameters,
        effective_limits: execution.effective_limits ?? null,
      });
}

function systemConfigurationScope(systemId: string, request: GenerationRequest): string {
  return digestJson({
    system_id: systemId,
    parameters: request.parameters,
    factors: request.factors,
    target: request.target,
  });
}

async function finalizeAttempt(
  workingDirectory: string,
  finalDirectory: string,
  observation: unknown,
): Promise<string> {
  await writeJsonAtomic(join(workingDirectory, "observation.json"), observation);
  const evidenceDigest = await writeEvidenceManifest(workingDirectory);
  await mkdir(resolve(finalDirectory, ".."), { recursive: true });
  await rename(workingDirectory, finalDirectory);
  return evidenceDigest;
}

async function executeAttempt(
  loaded: LoadedBenchmark,
  plan: ExperimentPlan,
  attempt: PlannedAttempt,
  descriptor: GeneratorDescriptor,
  runInstanceId: string,
  runDirectory: string,
  ledger: Ledger,
  systemConfigurations: Map<string, { digest: string; attemptId: string }>,
  referencePricing: OpenRouterReferencePricing | undefined,
  signal: AbortSignal,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const startedMonotonic = performance.now();
  if (!ledger.claim(attempt.id, startedAt)) {
    return;
  }

  const system = plan.systems.find((candidate) => candidate.id === attempt.systemId);
  const datasetCase = plan.cases.find((candidate) => candidate.id === attempt.caseId);
  if (!system || !datasetCase) {
    throw new Error(`plan is internally inconsistent for attempt ${attempt.id}`);
  }
  const workingDirectory = join(runDirectory, ".work", `${attempt.id}-${crypto.randomUUID()}`);
  const finalDirectory = join(runDirectory, "attempts", attempt.id);
  const outputDirectory = join(workingDirectory, "output");
  const requestPath = join(workingDirectory, "request.json");
  const responsePath = join(outputDirectory, "response.json");
  const stdoutPath = join(workingDirectory, "stdout.log");
  const stderrPath = join(workingDirectory, "stderr.log");
  await mkdir(outputDirectory, { recursive: true });

  const request = generationRequestSchema.parse({
    protocol_version: GENERATION_PROTOCOL_VERSION,
    attempt: {
      id: `obs-${sha256(`${runInstanceId}\0${attempt.id}`).slice(0, 32)}`,
      replicate: attempt.replicate,
      seed: attempt.seed,
    },
    case: {
      id: datasetCase.id,
      title: datasetCase.title,
      brief: datasetCase.brief,
      tags: datasetCase.tags,
    },
    target: {
      id: plan.target.id,
      version: plan.target.version,
      revision: plan.target.revision,
      parameters: datasetCase.targetParameters,
    },
    budget: plan.budget,
    factors: requestedFactors(system),
    parameters: system.parameters,
    output_dir: system.runtime.type === "container" ? "/work/output" : outputDirectory,
  });
  await writeJsonAtomic(requestPath, request);
  await Bun.write(stdoutPath, "");
  await Bun.write(stderrPath, "");

  let timedOut = false;
  let logLimitExceeded = false;
  const controller = new AbortController();
  const abortFromParent = (): void => controller.abort(signal.reason);
  signal.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("attempt timed out"));
  }, plan.budget.wall_time_ms);

  let exitCode: number | null = null;
  let executorError: string | undefined;
  let adapterStarted = false;
  try {
    const containerName = attemptContainerName(runInstanceId, attempt.id);
    if (system.runtime.type === "container") {
      await forceRemoveContainer(system, containerName);
    }
    const invocation = createRuntimeInvocation(system, {
      configDirectory: loaded.configDirectory,
      arguments:
        system.runtime.type === "container"
          ? ["generate", "--request", "/benchmark/request.json", "--output", "/work/output"]
          : ["generate", "--request", requestPath, "--output", outputDirectory],
      ...(system.runtime.type === "container"
        ? {
            mounts: [
              {
                source: requestPath,
                target: "/benchmark/request.json",
                readOnly: true,
              },
              {
                source: outputDirectory,
                target: "/work/output",
                readOnly: false,
              },
            ],
            containerWorkingDirectory: "/work/output",
            containerName,
          }
        : {}),
      includeDeclaredEnvironment: true,
    });
    const subprocess = Bun.spawn(runtimeCommand(system, invocation.argv), {
      cwd: invocation.cwd,
      env: runtimeEnvironment(system),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
      killSignal: "SIGTERM",
    });
    adapterStarted = true;
    const onLogLimit = (): void => {
      if (!logLimitExceeded) {
        logLimitExceeded = true;
        controller.abort(new Error("adapter log output exceeded configured limit"));
      }
    };
    const [completedExitCode] = await Promise.all([
      waitForSubprocessExit(
        subprocess,
        controller.signal,
        system.runtime.type === "container"
          ? () => forceRemoveContainer(system, containerName)
          : undefined,
      ),
      captureBoundedStream(
        subprocess.stdout,
        stdoutPath,
        loaded.config.execution.max_log_bytes,
        onLogLimit,
      ),
      captureBoundedStream(
        subprocess.stderr,
        stderrPath,
        loaded.config.execution.max_log_bytes,
        onLogLimit,
      ),
    ]);
    exitCode = completedExitCode;
  } catch (error) {
    executorError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abortFromParent);
  }

  const durationMs = Math.max(0, performance.now() - startedMonotonic);
  let terminalState: "completed" | "failed" | "cancelled" = "failed";
  let outcome: string | undefined;
  let errorCode: string | undefined;
  let artifactDigest: string | undefined;
  let response: GenerationResponse | undefined;

  if (signal.aborted && !timedOut) {
    terminalState = "cancelled";
    errorCode = "executor.cancelled";
  } else if (timedOut) {
    errorCode = "executor.timeout";
  } else if (logLimitExceeded) {
    errorCode = "executor.output_limit";
  } else if (executorError) {
    errorCode = "executor.spawn_failed";
  } else if (exitCode !== 0) {
    errorCode = "system.nonzero_exit";
  } else {
    try {
      response = generationResponseSchema.parse(
        JSON.parse(await readTextBounded(responsePath, RESPONSE_MAXIMUM_BYTES)),
      );
      await validateDiagnostics(response, outputDirectory);
      outcome = response.status;
      artifactDigest = await validateAndDigestArtifacts(response, outputDirectory);
      if (response.status === "infra_failed") {
        terminalState = "failed";
        errorCode = "generator.infrastructure";
      } else {
        terminalState = "completed";
      }
    } catch (error) {
      errorCode = "protocol.invalid_response";
      executorError = error instanceof Error ? error.message : String(error);
    }
  }

  if (
    adapterStarted &&
    descriptor.capabilities.crash_recovery === "cancel" &&
    (response === undefined || response.status === "infra_failed")
  ) {
    try {
      await recoverRemoteAttempt(loaded, system, attempt, runInstanceId, workingDirectory);
    } catch (error) {
      throw new RemoteRecoveryPendingError(
        `system ${system.id} could not reconcile remote work for attempt ${attempt.id}`,
        { cause: error },
      );
    }
    ledger.appendEvent(attempt.id, "attempt.remote_recovered", { action: "cancel" });
    if (response !== undefined) {
      try {
        await validateDiagnostics(response, outputDirectory);
        artifactDigest = await validateAndDigestArtifacts(response, outputDirectory);
      } catch (error) {
        response = undefined;
        outcome = undefined;
        artifactDigest = undefined;
        errorCode = "protocol.invalid_response";
        executorError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  if (terminalState === "completed" && response !== undefined) {
    const seedContradiction = seedDisagreement(descriptor, response);
    const disagreements = [
      ...factorDisagreements(system, response),
      ...(seedContradiction === undefined ? [] : [seedContradiction]),
    ];
    const configurationDigest = systemConfigurationDigest(response);
    const configurationScope = systemConfigurationScope(system.id, request);
    const previousConfiguration = systemConfigurations.get(configurationScope);
    if (
      configurationDigest !== undefined &&
      previousConfiguration !== undefined &&
      previousConfiguration.digest !== configurationDigest
    ) {
      disagreements.push(
        `system configuration changed since attempt ${previousConfiguration.attemptId}`,
      );
    }
    if (disagreements.length > 0) {
      terminalState = "failed";
      errorCode = "generator.attestation_mismatch";
      executorError = disagreements.join("; ");
    } else if (configurationDigest !== undefined && previousConfiguration === undefined) {
      systemConfigurations.set(configurationScope, {
        digest: configurationDigest,
        attemptId: attempt.id,
      });
    }
  }

  const finishedAt = new Date().toISOString();
  const budgetAssessment = assessBudget(response, plan.budget, { durationMs, timedOut });
  const referenceCost = await referencePricing?.price(system.id, response, workingDirectory);
  const observation = {
    schema_version: "1",
    observation_id: request.attempt.id,
    plan_attempt_id: attempt.id,
    generation_key: attempt.generationKey,
    lifecycle: terminalState,
    outcome,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
    budget: {
      status: budgetAssessment.status,
      violations: budgetAssessment.violations,
      missing: budgetAssessment.missing,
    },
    budget_dimensions: budgetAssessment.dimensions,
    system_configuration: response?.execution
      ? {
          effective_parameters: response.execution.effective_parameters,
          effective_limits: response.execution.effective_limits ?? null,
          observed_factors: response.execution.observed_factors,
        }
      : null,
    executor: {
      exit_code: exitCode,
      timed_out: timedOut,
      log_limit_exceeded: logLimitExceeded,
      error_code: errorCode,
      message: executorError,
    },
    artifact_digest: artifactDigest,
    reference_cost: referenceCost,
    response,
  };

  let evidenceDigest: string;
  try {
    evidenceDigest = await finalizeAttempt(workingDirectory, finalDirectory, observation);
  } catch (error) {
    await rm(workingDirectory, { recursive: true, force: true });
    throw error;
  }

  ledger.finish(attempt.id, terminalState, {
    occurredAt: finishedAt,
    ...(outcome === undefined ? {} : { outcome }),
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(artifactDigest === undefined ? {} : { artifactDigest }),
    evidenceDigest,
  });
}

function summarize(
  runId: string,
  runDirectory: string,
  ledger: Ledger,
  interrupted: boolean,
): RunSummary {
  const rows = ledger.list();
  const counts: Record<string, number> = {};
  for (const row of rows) {
    counts[row.state] = (counts[row.state] ?? 0) + 1;
  }
  return { runId, directory: runDirectory, total: rows.length, counts, interrupted };
}

type FinalizedState = "completed" | "failed" | "cancelled" | "interrupted";

interface FinalizedAttempt {
  state: FinalizedState;
  finishedAt: string;
  outcome?: string;
  errorCode?: string;
  artifactDigest?: string;
  evidenceDigest: string;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`finalized attempt has an invalid ${field}`);
  }
  return value;
}

async function readFinalizedAttempt(
  runDirectory: string,
  attempt: AttemptRow,
): Promise<FinalizedAttempt> {
  const attemptDirectory = join(runDirectory, "attempts", attempt.id);
  const directoryMetadata = await lstat(attemptDirectory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error(`finalized attempt ${attempt.id} is not a real directory`);
  }
  const observation = JSON.parse(
    await readTextBounded(join(attemptDirectory, "observation.json"), OBSERVATION_MAXIMUM_BYTES),
  ) as Record<string, unknown>;
  const state = observation.lifecycle;
  if (
    state !== "completed" &&
    state !== "failed" &&
    state !== "cancelled" &&
    state !== "interrupted"
  ) {
    throw new Error(`finalized attempt ${attempt.id} has an invalid lifecycle`);
  }
  if (
    observation.plan_attempt_id !== attempt.id ||
    observation.generation_key !== attempt.generationKey ||
    observation.started_at !== attempt.startedAt
  ) {
    throw new Error(`finalized attempt ${attempt.id} does not match its ledger identity`);
  }
  const finishedAt = optionalString(observation.finished_at, "finished_at");
  if (!finishedAt || Number.isNaN(Date.parse(finishedAt))) {
    throw new Error(`finalized attempt ${attempt.id} has an invalid finished_at`);
  }
  const outcome = optionalString(observation.outcome, "outcome");
  const artifactDigest = optionalString(observation.artifact_digest, "artifact_digest");
  const executor =
    typeof observation.executor === "object" &&
    observation.executor !== null &&
    !Array.isArray(observation.executor)
      ? (observation.executor as Record<string, unknown>)
      : undefined;
  if (!executor) {
    throw new Error(`finalized attempt ${attempt.id} has no executor record`);
  }
  const finalizedErrorCode = optionalString(executor.error_code, "executor.error_code");
  const evidenceManifest = JSON.parse(
    await readTextBounded(
      join(attemptDirectory, "evidence-manifest.json"),
      EVIDENCE_MANIFEST_MAXIMUM_BYTES,
    ),
  ) as { digest?: unknown };
  const evidenceDigest = digestJson(await buildEvidenceManifest(attemptDirectory));
  if (evidenceManifest.digest !== evidenceDigest) {
    throw new Error(`evidence digest mismatch for terminal attempt ${attempt.id}`);
  }
  if (observation.response !== undefined) {
    const observedResponse = generationResponseSchema.parse(observation.response);
    const response = generationResponseSchema.parse(
      JSON.parse(
        await readTextBounded(
          join(attemptDirectory, "output", "response.json"),
          RESPONSE_MAXIMUM_BYTES,
        ),
      ),
    );
    if (digestJson(observedResponse) !== digestJson(response)) {
      throw new Error(`response mismatch for terminal attempt ${attempt.id}`);
    }
    await validateDiagnostics(response, join(attemptDirectory, "output"));
    const digest = await validateAndDigestArtifacts(response, join(attemptDirectory, "output"));
    if ((digest ?? null) !== (artifactDigest ?? null)) {
      throw new Error(`artifact digest mismatch for completed attempt ${attempt.id}`);
    }
  }
  return {
    state,
    finishedAt,
    ...(outcome === undefined ? {} : { outcome }),
    ...(finalizedErrorCode === undefined ? {} : { errorCode: finalizedErrorCode }),
    ...(artifactDigest === undefined ? {} : { artifactDigest }),
    evidenceDigest,
  };
}

async function reconcileFinalizedRunningAttempts(
  runDirectory: string,
  ledger: Ledger,
): Promise<number> {
  let reconciled = 0;
  for (const attempt of ledger.list(["running"])) {
    const attemptDirectory = join(runDirectory, "attempts", attempt.id);
    try {
      await lstat(attemptDirectory);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
    const finalized = await readFinalizedAttempt(runDirectory, attempt);
    ledger.finish(attempt.id, finalized.state, {
      occurredAt: finalized.finishedAt,
      ...(finalized.outcome === undefined ? {} : { outcome: finalized.outcome }),
      ...(finalized.errorCode === undefined ? {} : { errorCode: finalized.errorCode }),
      ...(finalized.artifactDigest === undefined
        ? {}
        : { artifactDigest: finalized.artifactDigest }),
      evidenceDigest: finalized.evidenceDigest,
    });
    reconciled += 1;
  }
  return reconciled;
}

async function verifyResumeEvidence(
  runDirectory: string,
  runId: string,
  plan: ExperimentPlan,
  ledger: Ledger,
  generatorDescriptors: GeneratorDescriptor[],
  manifest: StoredManifest,
): Promise<string> {
  if (manifest.run_id !== runId || manifest.plan?.id !== plan.id) {
    throw new Error("run manifest does not match the requested run ID and resolved plan");
  }
  if (typeof manifest.run_instance_id !== "string" || manifest.run_instance_id.length === 0) {
    throw new Error("run manifest does not contain a valid run instance ID");
  }
  const recordedDescriptors = generatorDescriptorSchema
    .array()
    .parse(manifest.provenance?.generator_descriptors);
  if (digestJson(recordedDescriptors) !== digestJson(generatorDescriptors)) {
    throw new Error("generator capabilities or effective runtime changed since this run started");
  }

  for (const attempt of ledger.list(["completed", "failed", "cancelled", "interrupted"])) {
    if (!attempt.evidenceDigest) {
      throw new Error(`terminal attempt ${attempt.id} has no evidence digest`);
    }
    const finalized = await readFinalizedAttempt(runDirectory, attempt);
    if (
      finalized.state !== attempt.state ||
      (finalized.outcome ?? null) !== attempt.outcome ||
      (finalized.errorCode ?? null) !== attempt.errorCode ||
      (finalized.artifactDigest ?? null) !== attempt.artifactDigest ||
      finalized.evidenceDigest !== attempt.evidenceDigest
    ) {
      throw new Error(`finalized attempt ${attempt.id} does not reconcile with its ledger row`);
    }
  }
  await reconcileFinalizedRunningAttempts(runDirectory, ledger);
  return manifest.run_instance_id;
}

async function loadResumeManifest(
  runDirectory: string,
  runId: string,
  plan: ExperimentPlan,
): Promise<StoredManifest & { run_instance_id: string }> {
  const manifest = JSON.parse(
    await readTextBounded(join(runDirectory, "manifest.json"), OBSERVATION_MAXIMUM_BYTES),
  ) as StoredManifest;
  if (
    manifest.run_id !== runId ||
    manifest.plan?.id !== plan.id ||
    typeof manifest.run_instance_id !== "string" ||
    manifest.run_instance_id.length === 0
  ) {
    throw new Error("run manifest does not match the requested run and resolved plan");
  }
  return manifest as StoredManifest & { run_instance_id: string };
}

async function cleanupRecoveredAttemptContainers(
  plan: ExperimentPlan,
  ledger: Ledger,
  runInstanceId: string,
): Promise<void> {
  for (const running of ledger.list(["running"])) {
    const attempt = plan.attempts.find((candidate) => candidate.id === running.id);
    const system = attempt
      ? plan.systems.find((candidate) => candidate.id === attempt.systemId)
      : undefined;
    if (!attempt || !system) {
      throw new Error(`running attempt ${running.id} is missing from the resolved plan`);
    }
    if (system.runtime.type === "container") {
      await forceRemoveContainer(system, attemptContainerName(runInstanceId, attempt.id));
    }
  }
}

async function findAttemptWorkingDirectory(
  runDirectory: string,
  attemptId: string,
): Promise<string | undefined> {
  const workDirectory = join(runDirectory, ".work");
  const matches = (await readdir(workDirectory, { withFileTypes: true })).filter((entry) =>
    entry.name.startsWith(`${attemptId}-`),
  );
  if (matches.length > 1) {
    throw new Error(`running attempt ${attemptId} has multiple working directories`);
  }
  const match = matches[0];
  if (!match) {
    return undefined;
  }
  if (!match.isDirectory()) {
    throw new Error(`working path for running attempt ${attemptId} is not a directory`);
  }
  return join(workDirectory, match.name);
}

async function recoverRemoteAttempt(
  loaded: LoadedBenchmark,
  system: System,
  attempt: PlannedAttempt,
  runInstanceId: string,
  workingDirectory: string,
): Promise<void> {
  const requestPath = join(workingDirectory, "request.json");
  const outputDirectory = join(workingDirectory, "output");
  const containerName = recoveryContainerName(runInstanceId, attempt.id);
  if (system.runtime.type === "container") {
    await forceRemoveContainer(system, containerName);
  }
  const invocation = createRuntimeInvocation(system, {
    configDirectory: loaded.configDirectory,
    arguments:
      system.runtime.type === "container"
        ? ["recover", "--request", "/benchmark/request.json", "--output", "/work/output"]
        : ["recover", "--request", requestPath, "--output", outputDirectory],
    ...(system.runtime.type === "container"
      ? {
          mounts: [
            { source: requestPath, target: "/benchmark/request.json", readOnly: true },
            { source: outputDirectory, target: "/work/output", readOnly: false },
          ],
          containerWorkingDirectory: "/work/output",
          containerName,
        }
      : {}),
    includeDeclaredEnvironment: true,
  });
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("adapter crash recovery timed out")),
    CRASH_RECOVERY_TIMEOUT_MS,
  );
  try {
    const subprocess = Bun.spawn(runtimeCommand(system, invocation.argv), {
      cwd: invocation.cwd,
      env: runtimeEnvironment(system),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
      killSignal: "SIGTERM",
    });
    const abortOnLimit = (): void => {
      controller.abort(new Error("adapter crash recovery output exceeded configured limit"));
    };
    const [exitCode, , stderr] = await Promise.all([
      waitForSubprocessExit(
        subprocess,
        controller.signal,
        system.runtime.type === "container"
          ? () => forceRemoveContainer(system, containerName)
          : undefined,
      ),
      captureBoundedText(subprocess.stdout, HANDSHAKE_STREAM_MAXIMUM_BYTES, abortOnLimit),
      captureBoundedText(subprocess.stderr, HANDSHAKE_STREAM_MAXIMUM_BYTES, abortOnLimit),
    ]);
    if (exitCode !== 0) {
      throw new Error(`adapter exited with code ${exitCode}: ${stderr.trim()}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function recoverDurableRemoteAttempts(
  loaded: LoadedBenchmark,
  plan: ExperimentPlan,
  ledger: Ledger,
  descriptors: GeneratorDescriptor[],
  runDirectory: string,
  runInstanceId: string,
): Promise<void> {
  for (const running of ledger.list(["running"])) {
    const attempt = plan.attempts.find((candidate) => candidate.id === running.id);
    const system = attempt
      ? plan.systems.find((candidate) => candidate.id === attempt.systemId)
      : undefined;
    const descriptor = system
      ? descriptors.find((candidate) => candidate.id === system.id)
      : undefined;
    if (!attempt || !system || !descriptor) {
      throw new Error(`running attempt ${running.id} is missing from the resolved plan`);
    }
    if (descriptor.capabilities.crash_recovery !== "cancel") {
      continue;
    }
    const workingDirectory = await findAttemptWorkingDirectory(runDirectory, attempt.id);
    if (!workingDirectory) {
      continue;
    }
    try {
      if (!(await lstat(join(workingDirectory, "request.json"))).isFile()) {
        throw new Error(`request for running attempt ${attempt.id} is not a regular file`);
      }
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
    try {
      await recoverRemoteAttempt(loaded, system, attempt, runInstanceId, workingDirectory);
    } catch (error) {
      throw new Error(
        `system ${system.id} could not recover remote work for attempt ${attempt.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    ledger.appendEvent(attempt.id, "attempt.remote_recovered", { action: "cancel" });
  }
}

async function finalizeInterruptedAttempt(
  plan: ExperimentPlan,
  ledger: Ledger,
  runDirectory: string,
  runInstanceId: string,
  attemptId: string,
): Promise<number> {
  const row = ledger.list(["running"]).find((candidate) => candidate.id === attemptId);
  if (!row) {
    return 0;
  }
  const attempt = plan.attempts.find((candidate) => candidate.id === row.id);
  if (!attempt) {
    throw new Error(`running attempt ${row.id} is missing from the resolved plan`);
  }
  let workingDirectory = await findAttemptWorkingDirectory(runDirectory, attempt.id);
  if (!workingDirectory) {
    workingDirectory = join(
      runDirectory,
      ".work",
      `${attempt.id}-recovered-${crypto.randomUUID()}`,
    );
    await mkdir(workingDirectory);
  }
  const finishedAt = new Date().toISOString();
  const budget = assessBudget(undefined, plan.budget, { timedOut: false });
  const evidenceDigest = await finalizeAttempt(
    workingDirectory,
    join(runDirectory, "attempts", attempt.id),
    {
      schema_version: "1",
      observation_id: `obs-${sha256(`${runInstanceId}\0${attempt.id}`).slice(0, 32)}`,
      plan_attempt_id: attempt.id,
      generation_key: attempt.generationKey,
      lifecycle: "interrupted",
      started_at: row.startedAt,
      finished_at: finishedAt,
      duration_ms: null,
      budget: { status: budget.status, violations: budget.violations, missing: budget.missing },
      budget_dimensions: budget.dimensions,
      system_configuration: null,
      executor: {
        exit_code: null,
        timed_out: false,
        log_limit_exceeded: false,
        error_code: "runner.interrupted",
      },
    },
  );
  ledger.finish(attempt.id, "interrupted", {
    occurredAt: finishedAt,
    errorCode: "runner.interrupted",
    evidenceDigest,
  });
  return 1;
}

async function finalizeInterruptedAttempts(
  plan: ExperimentPlan,
  ledger: Ledger,
  runDirectory: string,
  runInstanceId: string,
): Promise<number> {
  let finalized = 0;
  for (const row of ledger.list(["running"])) {
    finalized += await finalizeInterruptedAttempt(
      plan,
      ledger,
      runDirectory,
      runInstanceId,
      row.id,
    );
  }
  return finalized;
}

async function recordedSystemConfigurations(
  runDirectory: string,
  ledger: Ledger,
): Promise<Map<string, { digest: string; attemptId: string }>> {
  const configurations = new Map<string, { digest: string; attemptId: string }>();
  for (const attempt of ledger.list(["completed"])) {
    let observation: { response?: unknown };
    let request: GenerationRequest;
    try {
      observation = JSON.parse(
        await readTextBounded(
          join(runDirectory, "attempts", attempt.id, "observation.json"),
          OBSERVATION_MAXIMUM_BYTES,
        ),
      ) as { response?: unknown };
      request = generationRequestSchema.parse(
        JSON.parse(
          await readTextBounded(
            join(runDirectory, "attempts", attempt.id, "request.json"),
            REQUEST_MAXIMUM_BYTES,
          ),
        ),
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        continue;
      }
      throw error;
    }
    const scope = systemConfigurationScope(attempt.systemId, request);
    if (observation.response === undefined || configurations.has(scope)) {
      continue;
    }
    const digest = systemConfigurationDigest(generationResponseSchema.parse(observation.response));
    if (digest !== undefined) {
      configurations.set(scope, { digest, attemptId: attempt.id });
    }
  }
  return configurations;
}

async function runPlanLocked(
  loaded: LoadedBenchmark,
  plan: ExperimentPlan,
  runId: string,
  runDirectory: string,
  options: { create: boolean },
): Promise<RunSummary> {
  let ledger: Ledger;
  let generatorDescriptors: GeneratorDescriptor[];
  let resumeManifest: (StoredManifest & { run_instance_id: string }) | undefined;
  if (options.create) {
    generatorDescriptors = await preflightSystems(
      loaded,
      plan,
      sha256(resolve(runDirectory)).slice(0, 32),
    );
    await mkdir(join(runDirectory, ".work"), { recursive: true });
    ledger = await Ledger.create(runDirectory, plan);
  } else {
    ledger = Ledger.open(runDirectory);
    if (ledger.planId() !== plan.id) {
      ledger.close();
      throw new Error(`run ${runId} belongs to another plan`);
    }
    try {
      resumeManifest = await loadResumeManifest(runDirectory, runId, plan);
      await cleanupRecoveredAttemptContainers(plan, ledger, resumeManifest.run_instance_id);
      generatorDescriptors = await preflightSystems(
        loaded,
        plan,
        sha256(resolve(runDirectory)).slice(0, 32),
      );
    } catch (error) {
      ledger.close();
      throw error;
    }
  }
  let runInstanceId: string;

  if (options.create) {
    try {
      const manifest = await createRunManifest(runId, plan, generatorDescriptors);
      await writeJsonAtomic(join(runDirectory, "manifest.json"), manifest);
      runInstanceId = manifest.run_instance_id;
      ledger.appendEvent(null, "run.created", { run_id: runId, plan_id: plan.id });
    } catch (error) {
      ledger.close();
      throw error;
    }
  } else {
    try {
      if (!resumeManifest) {
        throw new Error("run manifest is unavailable");
      }
      runInstanceId = await verifyResumeEvidence(
        runDirectory,
        runId,
        plan,
        ledger,
        generatorDescriptors,
        resumeManifest,
      );
      await recoverDurableRemoteAttempts(
        loaded,
        plan,
        ledger,
        generatorDescriptors,
        runDirectory,
        runInstanceId,
      );
      const recovered = await finalizeInterruptedAttempts(
        plan,
        ledger,
        runDirectory,
        runInstanceId,
      );
      if (recovered > 0) {
        ledger.appendEvent(null, "run.recovered", { interrupted_attempts: recovered });
      }
    } catch (error) {
      ledger.close();
      throw error;
    }
  }

  const controller = new AbortController();
  let interrupted = false;
  const interrupt = (): void => {
    interrupted = true;
    controller.abort(new Error("interrupted"));
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  const systemConfigurations = await recordedSystemConfigurations(runDirectory, ledger);
  const referencePricing = plan.reference_pricing
    ? new OpenRouterReferencePricing(runDirectory, plan.reference_pricing)
    : undefined;
  const queue = new PQueue({ concurrency: loaded.config.execution.concurrency });
  const pending = ledger.list(["planned"]);
  const tasks: Promise<void>[] = [];
  const taskErrors: unknown[] = [];
  try {
    for (const attemptRow of pending) {
      if (controller.signal.aborted) {
        break;
      }
      const attempt = plan.attempts.find((candidate) => candidate.id === attemptRow.id);
      if (!attempt) {
        throw new Error(`attempt ${attemptRow.id} is missing from the plan`);
      }
      const descriptor = generatorDescriptors.find(
        (candidate) => candidate.id === attempt.systemId,
      );
      if (!descriptor) {
        throw new Error(`system ${attempt.systemId} has no generator descriptor`);
      }
      const task = queue
        .add(async () => {
          if (controller.signal.aborted) {
            return;
          }
          try {
            await executeAttempt(
              loaded,
              plan,
              attempt,
              descriptor,
              runInstanceId,
              runDirectory,
              ledger,
              systemConfigurations,
              referencePricing,
              controller.signal,
            );
          } catch (error) {
            if (!(error instanceof RemoteRecoveryPendingError)) {
              await finalizeInterruptedAttempt(
                plan,
                ledger,
                runDirectory,
                runInstanceId,
                attempt.id,
              );
            }
            throw error;
          }
        })
        .then(() => undefined)
        .catch((error: unknown) => {
          taskErrors.push(error);
        });
      tasks.push(task);
    }
    await Promise.all(tasks);
    if (taskErrors.length > 0) {
      throw new AggregateError(
        taskErrors,
        `${taskErrors.length} runner task(s) failed unexpectedly`,
      );
    }
    return summarize(runId, runDirectory, ledger, interrupted);
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    ledger.close();
  }
}

export async function runPlan(
  loaded: LoadedBenchmark,
  plan: ExperimentPlan,
  runId: string,
  runDirectory: string,
  options: { create: boolean },
): Promise<RunSummary> {
  if (options.create) {
    await mkdir(resolve(runDirectory, ".."), { recursive: true });
    await mkdir(runDirectory);
  }
  const releaseLock = await acquireRunCoordinatorLock(runDirectory);
  try {
    return await runPlanLocked(loaded, plan, runId, runDirectory, options);
  } finally {
    await releaseLock();
  }
}

export function readRunSummary(runDirectoryInput: string): RunSummary {
  const runDirectory = resolve(runDirectoryInput);
  const ledger = Ledger.open(runDirectory);
  try {
    return summarize(basename(runDirectory), runDirectory, ledger, false);
  } finally {
    ledger.close();
  }
}
