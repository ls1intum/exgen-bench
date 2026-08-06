import {
  evaluationRequestSchema,
  evaluationResponseSchema,
  type EvaluationFailureCategory,
  type EvaluationRequest,
  type EvaluationResponse,
  type EvaluationScore,
} from "../../src/evaluation/contracts.ts";
import { BundleError } from "./bundle.ts";

/**
 * The half of evaluation protocol v1 that every evaluator in this directory shares.
 *
 * The rule this file exists to enforce is the one in the plan: a timeout, a crash, or an unreachable
 * backend maps to `infra_failure` and *never* to a quality verdict. An evaluator that reports a
 * broken build agent as "the exercise does not compile" would move the primary outcome without
 * anything in the benchmark recording that it had.
 */

export interface EvaluationOutcome {
  /** The metric that decides acceptance, or null when this evaluator is not an acceptance gate. */
  gate: { metricId: string; satisfied: boolean } | null;
  scores: EvaluationScore[];
  failureCategory?: EvaluationFailureCategory;
}

export type Evaluate = (request: EvaluationRequest) => Promise<EvaluationOutcome>;

/** Raised by an evaluator when the cause is infrastructure and no quality verdict is admissible. */
export class InfrastructureError extends Error {
  readonly category: EvaluationFailureCategory;

  constructor(message: string, category: EvaluationFailureCategory = "infrastructure.unavailable") {
    super(message);
    this.category = category;
  }
}

export function candidateIdentity(
  request: EvaluationRequest,
): Omit<EvaluationRequest["candidate"], "bundle_path"> {
  const { bundle_path: _bundlePath, ...identity } = request.candidate;
  return identity;
}

/** A score for a metric the evaluator knows about but cannot observe for this candidate. */
export function notApplicable(
  metricId: string,
  metricVersion: string,
  message: string,
): EvaluationScore {
  return {
    metric_id: metricId,
    metric_version: metricVersion,
    status: "not_applicable",
    message,
    evidence: [],
  };
}

export function score(
  metricId: string,
  metricVersion: string,
  value: number | boolean | string,
  extra: { numerator?: number; denominator?: number; evidence?: string[] } = {},
): EvaluationScore {
  return {
    metric_id: metricId,
    metric_version: metricVersion,
    status: "ok",
    value,
    ...(extra.numerator === undefined ? {} : { numerator: extra.numerator }),
    ...(extra.denominator === undefined ? {} : { denominator: extra.denominator }),
    evidence: extra.evidence ?? [],
  };
}

function buildResponse(
  request: EvaluationRequest,
  outcome: EvaluationOutcome,
  startedAt: string,
  finishedAt: string,
  durationMs: number,
): EvaluationResponse {
  const accepted = outcome.gate === null ? true : outcome.gate.satisfied;
  const failureCategory =
    outcome.failureCategory ?? (accepted ? undefined : "quality.threshold_not_met");
  return evaluationResponseSchema.parse({
    protocol_version: "1",
    evaluation_id: request.evaluation_id,
    candidate: candidateIdentity(request),
    evaluator: request.evaluator,
    suite: request.suite,
    status: accepted ? "succeeded" : "quality_failed",
    strict_success: accepted,
    ...(accepted ? {} : { failure_category: failureCategory }),
    scores: outcome.scores,
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
  });
}

function infrastructureResponse(
  request: EvaluationRequest,
  category: EvaluationFailureCategory,
  message: string,
  startedAt: string,
  finishedAt: string,
  durationMs: number,
): EvaluationResponse {
  return evaluationResponseSchema.parse({
    protocol_version: "1",
    evaluation_id: request.evaluation_id,
    candidate: candidateIdentity(request),
    evaluator: request.evaluator,
    suite: request.suite,
    status: "infra_failed",
    strict_success: null,
    failure_category: category,
    scores: [
      {
        metric_id: "evaluation.runtime",
        metric_version: "1",
        status: "infra_failure",
        message,
        evidence: [],
      },
    ],
    started_at: startedAt,
    finished_at: finishedAt,
    duration_ms: durationMs,
  });
}

/**
 * Run an evaluator over one request and produce exactly one schema-valid response.
 *
 * A malformed or unreadable candidate is a *quality* failure (`candidate.invalid`): the generator
 * produced it, so it is a fact about the system under test. Anything else that escapes the evaluator
 * is infrastructure.
 */
export async function runEvaluation(
  request: EvaluationRequest,
  evaluate: Evaluate,
  now: () => Date = () => new Date(),
): Promise<EvaluationResponse> {
  const startedAt = now();
  const monotonic = performance.now();
  const elapsed = (): number => Math.round(Math.max(0, performance.now() - monotonic));
  try {
    const outcome = await evaluate(request);
    const missing = request.requested_metrics.filter(
      (metricId) => !outcome.scores.some((entry) => entry.metric_id === metricId),
    );
    if (missing.length > 0) {
      throw new InfrastructureError(
        `evaluator did not produce requested metrics: ${missing.join(", ")}`,
        "evaluator.protocol_error",
      );
    }
    return buildResponse(request, outcome, startedAt.toISOString(), now().toISOString(), elapsed());
  } catch (error) {
    if (error instanceof BundleError) {
      return buildResponse(
        request,
        {
          gate: { metricId: "candidate.readable", satisfied: false },
          failureCategory: "candidate.invalid",
          scores: request.requested_metrics.map((metricId) => ({
            metric_id: metricId,
            metric_version: "1",
            status: "quality_failure" as const,
            message: error.message,
            evidence: [],
          })),
        },
        startedAt.toISOString(),
        now().toISOString(),
        elapsed(),
      );
    }
    return infrastructureResponse(
      request,
      error instanceof InfrastructureError ? error.category : "evaluator.crashed",
      error instanceof Error ? error.message : String(error),
      startedAt.toISOString(),
      now().toISOString(),
      elapsed(),
    );
  }
}

const MAXIMUM_REQUEST_BYTES = 4 * 1024 * 1024;

/**
 * The stdin/stdout entry point every worker in this directory uses: read one request, write one
 * response, never write anything else to stdout.
 */
export async function serveEvaluator(evaluate: Evaluate): Promise<void> {
  const input = await Bun.stdin.text();
  if (Buffer.byteLength(input) > MAXIMUM_REQUEST_BYTES) {
    throw new Error(`evaluation request exceeds ${MAXIMUM_REQUEST_BYTES} bytes`);
  }
  const request = evaluationRequestSchema.parse(JSON.parse(input));
  const response = await runEvaluation(request, evaluate);
  process.stdout.write(JSON.stringify(response));
}
