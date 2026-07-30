import { lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { generationResponseSchema, type Target } from "../../src/contracts.ts";
import { validateAndDigestArtifacts } from "../../src/adapters/artifacts.ts";
import { readTextBounded } from "../../src/core/files.ts";
import {
  evaluationResponseSchema,
  type EvaluationRequest,
  type EvaluationResponse,
  type EvaluationScore,
} from "../../src/evaluation/contracts.ts";
import type {
  EvaluationExecutionContext,
  EvaluationExecutor,
} from "../../src/evaluation/runner.ts";
import { createEvaluationProcessExecutor } from "../../src/evaluation/process-executor.ts";
import { artemisParametersSchema, type ArtemisParameters } from "./config.ts";
import {
  ArtemisVerifier,
  artemisVerificationRequestSchema,
  type ArtemisVerificationResponse,
} from "./verifier.ts";

export interface ArtemisEvaluationOptions {
  parameters: ArtemisParameters;
  evidenceRoot: string;
  target: Target;
}

interface ReadBudget {
  bytes: number;
  files: number;
}

const MAX_FILES = 10_000;
const RESPONSE_MAXIMUM_BYTES = 16 * 1024 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function candidateIdentity(
  request: EvaluationRequest,
): Omit<EvaluationRequest["candidate"], "bundle_path"> {
  const { bundle_path: _, ...identity } = request.candidate;
  return identity;
}

function resolveContained(root: string, path: string): string {
  if (isAbsolute(path)) {
    throw new Error(`candidate artifact path must be relative: ${path}`);
  }
  const destination = resolve(root, path);
  const relativePath = relative(root, destination);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`candidate artifact escapes its bundle: ${path}`);
  }
  return destination;
}

async function readText(path: string, budget: ReadBudget, maxBytes: number): Promise<string> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink > 1) {
    throw new Error(`candidate contains an unsafe file: ${path}`);
  }
  budget.files += 1;
  budget.bytes += metadata.size;
  if (budget.files > MAX_FILES || budget.bytes > maxBytes) {
    throw new Error("candidate exceeds Artemis evaluator file or byte limits");
  }
  return textDecoder.decode(await readFile(path));
}

async function readTree(
  root: string,
  budget: ReadBudget,
  maxBytes: number,
): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`candidate contains an unsafe directory: ${directory}`);
    }
    const entries = await readdir(directory);
    entries.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry);
      const entryMetadata = await lstat(path);
      if (entryMetadata.isDirectory()) {
        await walk(path);
      } else {
        const relativePath = relative(root, path).split(sep).join("/");
        files[relativePath] = await readText(path, budget, maxBytes);
      }
    }
  };
  await walk(root);
  return files;
}

async function locateResponse(bundlePath: string): Promise<{
  outputRoot: string;
  response: ReturnType<typeof generationResponseSchema.parse>;
}> {
  for (const outputRoot of [resolve(bundlePath), resolve(bundlePath, "output")]) {
    try {
      const response = generationResponseSchema.parse(
        JSON.parse(
          await readTextBounded(join(outputRoot, "response.json"), RESPONSE_MAXIMUM_BYTES),
        ),
      );
      return { outputRoot, response };
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }
  }
  throw new Error("candidate bundle does not contain response.json");
}

async function readCanonicalCandidate(
  request: EvaluationRequest,
  maxBytes: number,
): Promise<{
  problem_statement: string;
  template: Record<string, string>;
  solution: Record<string, string>;
  tests: Record<string, string>;
  metadata: Record<string, unknown>;
}> {
  const { outputRoot, response } = await locateResponse(request.candidate.bundle_path);
  const effectiveDigest = await validateAndDigestArtifacts(response, outputRoot);
  if (effectiveDigest !== request.candidate.artifact_digest) {
    throw new Error("candidate artifact digest changed after generation");
  }
  const artifacts = new Map(response.artifacts.map((artifact) => [artifact.role, artifact]));
  const required = ["problem_statement", "template", "solution", "tests"] as const;
  for (const role of required) {
    if (!artifacts.has(role)) {
      throw new Error(`candidate bundle is missing ${role}`);
    }
  }
  const budget: ReadBudget = { bytes: 0, files: 0 };
  const problemPath = resolveContained(outputRoot, artifacts.get("problem_statement")?.path ?? "");
  const templatePath = resolveContained(outputRoot, artifacts.get("template")?.path ?? "");
  const solutionPath = resolveContained(outputRoot, artifacts.get("solution")?.path ?? "");
  const testsPath = resolveContained(outputRoot, artifacts.get("tests")?.path ?? "");
  const [problemStatement, template, solution, tests] = await Promise.all([
    readText(problemPath, budget, maxBytes),
    readTree(templatePath, budget, maxBytes),
    readTree(solutionPath, budget, maxBytes),
    readTree(testsPath, budget, maxBytes),
  ]);
  return {
    problem_statement: problemStatement,
    template,
    solution,
    tests,
    metadata: {
      evaluation_id: request.evaluation_id,
      artifact_digest: request.candidate.artifact_digest,
      generation_key: request.candidate.generation_key,
    },
  };
}

function qualityFailureCategory(
  report: Record<string, unknown>,
): EvaluationResponse["failure_category"] {
  const declared = report.failure_category;
  if (
    typeof declared === "string" &&
    [
      "candidate.invalid",
      "candidate.incomplete",
      "tests.failed",
      "build.failed",
      "quality.threshold_not_met",
      "other",
    ].includes(declared)
  ) {
    return declared as EvaluationResponse["failure_category"];
  }
  return "quality.threshold_not_met";
}

function requestedScores(
  request: EvaluationRequest,
  verification: ArtemisVerificationResponse,
  evidence: string[],
): EvaluationScore[] {
  const strictSuccess = verification.status === "passed";
  const metrics =
    typeof verification.report.metrics === "object" &&
    verification.report.metrics !== null &&
    !Array.isArray(verification.report.metrics)
      ? (verification.report.metrics as Record<string, unknown>)
      : {};
  const metricIds = new Set(request.requested_metrics);
  metricIds.add("artemis.canonical_acceptance");
  return [...metricIds].sort().map((metricId): EvaluationScore => {
    if (verification.status === "error") {
      return {
        metric_id: metricId,
        metric_version: "1",
        status: "infra_failure",
        message: "Artemis canonical verifier did not produce a quality verdict",
        evidence,
      };
    }
    if (metricId === "artemis.canonical_acceptance") {
      return {
        metric_id: metricId,
        metric_version: "1",
        status: strictSuccess ? "ok" : "quality_failure",
        value: strictSuccess,
        evidence,
      };
    }
    const value = metrics[metricId];
    if (
      typeof value === "string" ||
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isFinite(value))
    ) {
      return {
        metric_id: metricId,
        metric_version: "1",
        status: strictSuccess ? "ok" : "quality_failure",
        value,
        evidence,
      };
    }
    return {
      metric_id: metricId,
      metric_version: "1",
      status: "not_applicable",
      message: "metric is not present in the canonical Artemis verification report",
      evidence,
    };
  });
}

export async function evaluateCandidateWithArtemis(
  request: EvaluationRequest,
  context: EvaluationExecutionContext,
  options: ArtemisEvaluationOptions,
): Promise<EvaluationResponse> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const parameters = artemisParametersSchema.parse(options.parameters);
  let candidate: Awaited<ReturnType<typeof readCanonicalCandidate>>;
  try {
    candidate = await readCanonicalCandidate(request, parameters.max_artifact_bytes);
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    return evaluationResponseSchema.parse({
      protocol_version: "1",
      evaluation_id: request.evaluation_id,
      candidate: candidateIdentity(request),
      evaluator: request.evaluator,
      suite: request.suite,
      status: "quality_failed",
      strict_success: false,
      failure_category: "candidate.invalid",
      scores: [...new Set([...request.requested_metrics, "artemis.canonical_acceptance"])]
        .sort()
        .map((metricId) => ({
          metric_id: metricId,
          metric_version: "1",
          status: "quality_failure",
          ...(metricId === "artemis.canonical_acceptance" ? { value: false } : {}),
          message,
          evidence: ["response.json"],
        })),
      started_at: startedAt,
      finished_at: finishedAt,
      duration_ms: Math.max(0, Math.round(performance.now() - started)),
    });
  }
  const outputDirectory = join(resolve(options.evidenceRoot), request.evaluation_id);
  const verificationRequest = artemisVerificationRequestSchema.parse({
    protocol_version: "1",
    attempt_id: request.evaluation_id,
    candidate_digest: request.candidate.artifact_digest,
    target: {
      id: options.target.id,
      version: options.target.version,
      revision: options.target.revision,
      parameters: options.target.parameters ?? {},
    },
    verifier_profile: request.evaluator.target_profile,
    evaluator: request.evaluator,
    suite: request.suite,
    budget: { wall_time_ms: request.timeout_ms ?? 30 * 60 * 1_000 },
    parameters,
    candidate,
  });
  const verifier = new ArtemisVerifier(verificationRequest, outputDirectory);
  const verification: ArtemisVerificationResponse = await verifier.verify(context.signal);
  const finishedAt = new Date().toISOString();
  const evidence = [
    `artemis-verification-run:${verification.run_id}`,
    `${request.evaluation_id}/artemis-verifier/evidence.json`,
  ];
  const status =
    verification.status === "passed"
      ? "succeeded"
      : verification.status === "failed"
        ? "quality_failed"
        : "infra_failed";
  return evaluationResponseSchema.parse({
    protocol_version: "1",
    evaluation_id: request.evaluation_id,
    candidate: candidateIdentity(request),
    evaluator: request.evaluator,
    suite: request.suite,
    status,
    strict_success:
      verification.status === "passed" ? true : verification.status === "failed" ? false : null,
    failure_category:
      verification.status === "failed"
        ? qualityFailureCategory(verification.report)
        : verification.status === "error"
          ? "infrastructure.unavailable"
          : undefined,
    scores: requestedScores(request, verification, evidence),
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: Math.max(0, Math.round(performance.now() - started)),
  });
}

export function createArtemisEvaluationExecutor(
  options: ArtemisEvaluationOptions,
): EvaluationExecutor {
  const parameters = artemisParametersSchema.parse(options.parameters);
  const env: Record<string, string> = {};
  if (parameters.auth.type === "bearer") {
    const token = process.env[parameters.auth.token_env];
    if (!token) {
      throw new Error(
        `missing Artemis credential environment variable ${parameters.auth.token_env}`,
      );
    }
    env[parameters.auth.token_env] = token;
  }
  return createEvaluationProcessExecutor({
    argv: [process.execPath, "run", join(import.meta.dir, "evaluation-worker.ts")],
    env,
    input: (request) => ({
      request,
      options: {
        parameters,
        evidence_root: options.evidenceRoot,
        target: options.target,
      },
    }),
    responseSchema: evaluationResponseSchema,
  });
}
