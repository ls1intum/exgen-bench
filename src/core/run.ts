import { lstat, mkdir, readFile, readlink, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, join, resolve } from "node:path";
import PQueue from "p-queue";
import { validateAndDigestArtifacts } from "../adapters/artifacts.ts";
import {
  type GenerationResponse,
  type GeneratorDescriptor,
  generationRequestSchema,
  generationResponseSchema,
  generatorDescriptorSchema,
  type System,
} from "../contracts.ts";
import { digestJson, sha256 } from "./canonical.ts";
import { buildEvidenceManifest, sha256File, writeEvidenceManifest } from "./evidence.ts";
import { writeJsonAtomic } from "./files.ts";
import { type AttemptRow, Ledger } from "./ledger.ts";
import type { LoadedBenchmark } from "./load.ts";
import type { ExperimentPlan, PlannedAttempt } from "./plan.ts";
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

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  acquired_at: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

export async function acquireRunCoordinatorLock(
  runDirectory: string,
): Promise<() => Promise<void>> {
  const lockDirectory = join(runDirectory, ".coordinator.lock");
  const ownerPath = join(lockDirectory, "owner.json");
  const owner: LockOwner = {
    token: crypto.randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    acquired_at: new Date().toISOString(),
  };

  for (;;) {
    try {
      await mkdir(lockDirectory);
      await writeJsonAtomic(ownerPath, owner);
      break;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      let incumbent: LockOwner;
      try {
        incumbent = JSON.parse(await readFile(ownerPath, "utf8")) as LockOwner;
      } catch {
        throw new Error(`run is locked and its owner record is unavailable: ${runDirectory}`);
      }
      if (
        incumbent.hostname !== owner.hostname ||
        !Number.isSafeInteger(incumbent.pid) ||
        processIsAlive(incumbent.pid)
      ) {
        throw new Error(`run is already owned by PID ${incumbent.pid} on ${incumbent.hostname}`);
      }
      const staleDirectory = `${lockDirectory}.stale-${crypto.randomUUID()}`;
      try {
        await rename(lockDirectory, staleDirectory);
        await rm(staleDirectory, { recursive: true, force: true });
      } catch (takeoverError) {
        if (errorCode(takeoverError) !== "ENOENT") {
          throw takeoverError;
        }
      }
    }
  }

  return async () => {
    const recorded = JSON.parse(await readFile(ownerPath, "utf8")) as LockOwner;
    if (recorded.token !== owner.token) {
      throw new Error("run coordinator ownership changed unexpectedly");
    }
    await rm(lockDirectory, { recursive: true });
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

function assessBudget(
  response: GenerationResponse | undefined,
  budget: ExperimentPlan["budget"],
): { status: "compliant" | "exceeded" | "unverifiable"; violations: string[]; missing: string[] } {
  const violations: string[] = [];
  const missing: string[] = [];
  const checks: Array<[string, number | undefined, number | undefined]> = [
    ["model_calls", response?.usage?.model_calls, budget.max_model_calls],
    ["tool_calls", response?.usage?.tool_calls, budget.max_tool_calls],
    ["input_tokens", response?.usage?.input_tokens, budget.max_input_tokens],
    ["output_tokens", response?.usage?.output_tokens, budget.max_output_tokens],
    ["total_tokens", response?.usage?.total_tokens, budget.max_total_tokens],
  ];
  for (const [name, actual, limit] of checks) {
    if (limit === undefined) {
      continue;
    }
    if (actual === undefined) {
      missing.push(name);
    } else if (actual > limit) {
      violations.push(`${name}:${actual}>${limit}`);
    }
  }
  if (budget.max_cost) {
    if (!response?.cost) {
      missing.push("cost");
    } else if (response.cost.currency !== budget.max_cost.currency) {
      missing.push(`cost_currency:${response.cost.currency}`);
    } else if (response.cost.amount > budget.max_cost.amount) {
      violations.push(`cost:${response.cost.amount}>${budget.max_cost.amount}`);
    }
  }
  return {
    status: violations.length > 0 ? "exceeded" : missing.length > 0 ? "unverifiable" : "compliant",
    violations,
    missing,
  };
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
      .map(async (path) => {
        const absolute = resolve(repository, path);
        const metadata = await lstat(absolute);
        return metadata.isSymbolicLink()
          ? { path, symlink: await readlink(absolute) }
          : { path, sha256: await sha256File(absolute) };
      }),
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

export async function preflightSystems(
  loaded: LoadedBenchmark,
  plan: ExperimentPlan,
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
      const invocation = createRuntimeInvocation(system, {
        configDirectory: loaded.configDirectory,
        arguments: ["describe", "--json"],
        includeDeclaredEnvironment: false,
      });
      const subprocess = Bun.spawn(invocation.argv, {
        cwd: invocation.cwd,
        env: resolveEnvironment(system, false),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        signal: controller.signal,
      });
      [exitCode, stdout, stderr] = await Promise.all([
        subprocess.exited,
        new Response(subprocess.stdout).text(),
        new Response(subprocess.stderr).text(),
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
    descriptors.push(descriptor);
  }
  return descriptors;
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
  runInstanceId: string,
  runDirectory: string,
  ledger: Ledger,
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
    protocol_version: "1",
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
    target: plan.target,
    budget: plan.budget,
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
  try {
    const invocation = createRuntimeInvocation(system, {
      configDirectory: loaded.configDirectory,
      arguments:
        system.runtime.type === "container"
          ? ["generate", "--request", "/work/request.json", "--output", "/work/output"]
          : ["generate", "--request", requestPath, "--output", outputDirectory],
      ...(system.runtime.type === "container" ? { mountDirectory: workingDirectory } : {}),
      includeDeclaredEnvironment: true,
    });
    const subprocess = Bun.spawn(invocation.argv, {
      cwd: invocation.cwd,
      env: resolveEnvironment(system),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const onLogLimit = (): void => {
      if (!logLimitExceeded) {
        logLimitExceeded = true;
        controller.abort(new Error("adapter log output exceeded configured limit"));
      }
    };
    const [completedExitCode] = await Promise.all([
      subprocess.exited,
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

  const finishedAt = new Date().toISOString();
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
      response = generationResponseSchema.parse(JSON.parse(await readFile(responsePath, "utf8")));
      outcome = response.status;
      artifactDigest = await validateAndDigestArtifacts(response, outputDirectory, plan.target);
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

  const budgetAssessment = assessBudget(response, plan.budget);
  if (timedOut || durationMs > plan.budget.wall_time_ms) {
    budgetAssessment.violations.push(
      `wall_time_ms:${Math.round(durationMs)}>${plan.budget.wall_time_ms}`,
    );
    budgetAssessment.status = "exceeded";
  }
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
    budget: budgetAssessment,
    executor: {
      exit_code: exitCode,
      timed_out: timedOut,
      log_limit_exceeded: logLimitExceeded,
      error_code: errorCode,
      message: executorError,
    },
    artifact_digest: artifactDigest,
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

type FinalizedState = "completed" | "failed" | "cancelled";

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
  plan: ExperimentPlan,
): Promise<FinalizedAttempt> {
  const attemptDirectory = join(runDirectory, "attempts", attempt.id);
  const directoryMetadata = await lstat(attemptDirectory);
  if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) {
    throw new Error(`finalized attempt ${attempt.id} is not a real directory`);
  }
  const observation = JSON.parse(
    await readFile(join(attemptDirectory, "observation.json"), "utf8"),
  ) as Record<string, unknown>;
  const state = observation.lifecycle;
  if (state !== "completed" && state !== "failed" && state !== "cancelled") {
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
    await readFile(join(attemptDirectory, "evidence-manifest.json"), "utf8"),
  ) as { digest?: unknown };
  const evidenceDigest = digestJson(await buildEvidenceManifest(attemptDirectory));
  if (evidenceManifest.digest !== evidenceDigest) {
    throw new Error(`evidence digest mismatch for terminal attempt ${attempt.id}`);
  }
  if (artifactDigest) {
    const response = generationResponseSchema.parse(
      JSON.parse(await readFile(join(attemptDirectory, "output", "response.json"), "utf8")),
    );
    const digest = await validateAndDigestArtifacts(
      response,
      join(attemptDirectory, "output"),
      plan.target,
    );
    if (digest !== artifactDigest) {
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
  plan: ExperimentPlan,
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
    const finalized = await readFinalizedAttempt(runDirectory, attempt, plan);
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
): Promise<string> {
  const manifest = JSON.parse(
    await readFile(join(runDirectory, "manifest.json"), "utf8"),
  ) as StoredManifest;
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

  for (const attempt of ledger.list(["completed", "failed", "cancelled"])) {
    if (!attempt.evidenceDigest) {
      throw new Error(`terminal attempt ${attempt.id} has no evidence digest`);
    }
    const finalized = await readFinalizedAttempt(runDirectory, attempt, plan);
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
  await reconcileFinalizedRunningAttempts(runDirectory, plan, ledger);
  return manifest.run_instance_id;
}

async function runPlanLocked(
  loaded: LoadedBenchmark,
  plan: ExperimentPlan,
  runId: string,
  runDirectory: string,
  options: { create: boolean },
): Promise<RunSummary> {
  const generatorDescriptors = await preflightSystems(loaded, plan);
  if (options.create) {
    await mkdir(join(runDirectory, ".work"), { recursive: true });
  }
  const ledger = options.create
    ? await Ledger.create(runDirectory, plan)
    : Ledger.open(runDirectory);
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
  } else if (ledger.planId() !== plan.id) {
    ledger.close();
    throw new Error(`run ${runId} belongs to another plan`);
  } else {
    try {
      runInstanceId = await verifyResumeEvidence(
        runDirectory,
        runId,
        plan,
        ledger,
        generatorDescriptors,
      );
      const recovered = ledger.recoverRunning(new Date().toISOString());
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
              runInstanceId,
              runDirectory,
              ledger,
              controller.signal,
            );
          } catch (error) {
            const row = ledger.list().find((candidate) => candidate.id === attempt.id);
            if (row?.state === "running") {
              ledger.finish(attempt.id, "failed", {
                occurredAt: new Date().toISOString(),
                errorCode: "runner.unexpected_error",
              });
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
