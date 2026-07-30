import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import PQueue from "p-queue";
import { digestJson } from "../core/canonical.ts";
import {
  EVALUATION_PROTOCOL_VERSION,
  evaluationRequestSchema,
  evaluationResponseSchema,
  type EvaluationCandidate,
  type EvaluationRequest,
  type EvaluationResponse,
  type EvaluationSuite,
  type EvaluatorIdentity,
} from "./contracts.ts";

export interface EvaluationExecutionContext {
  signal: AbortSignal;
}

export type EvaluationExecutor = (
  request: EvaluationRequest,
  context: EvaluationExecutionContext,
) => Promise<EvaluationResponse>;

export interface EvaluationRunOptions {
  candidates: EvaluationCandidate[];
  evaluator: EvaluatorIdentity;
  suite: EvaluationSuite;
  requestedMetrics: string[];
  journalPath: string;
  execute: EvaluationExecutor;
  concurrency?: number;
  retryInfrastructureFailures?: boolean;
  timeoutMs?: number;
  now?: () => string;
}

export interface EvaluationRunResult {
  responses: EvaluationResponse[];
  executed: number;
  resumed: number;
}

function candidateIdentity(
  candidate: EvaluationCandidate,
): Omit<EvaluationCandidate, "bundle_path"> {
  const { bundle_path: _, ...identity } = candidate;
  return identity;
}

export function evaluationId(
  candidate: EvaluationCandidate,
  evaluator: EvaluatorIdentity,
  suite: EvaluationSuite,
  requestedMetrics: string[],
  timeoutMs?: number,
): string {
  return digestJson({
    protocol_version: EVALUATION_PROTOCOL_VERSION,
    candidate: candidateIdentity(candidate),
    evaluator,
    suite,
    requested_metrics: [...requestedMetrics].sort(),
    timeout_ms: timeoutMs ?? null,
  });
}

function buildRequest(
  candidate: EvaluationCandidate,
  options: EvaluationRunOptions,
): EvaluationRequest {
  const request: EvaluationRequest = {
    protocol_version: EVALUATION_PROTOCOL_VERSION,
    evaluation_id: evaluationId(
      candidate,
      options.evaluator,
      options.suite,
      options.requestedMetrics,
      options.timeoutMs,
    ),
    candidate,
    evaluator: options.evaluator,
    suite: options.suite,
    requested_metrics: [...options.requestedMetrics].sort(),
  };
  if (options.timeoutMs !== undefined) {
    request.timeout_ms = options.timeoutMs;
  }
  return evaluationRequestSchema.parse(request);
}

async function readEvaluationJournalRecords(path: string): Promise<EvaluationResponse[]> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const history: EvaluationResponse[] = [];
  const responses = new Map<string, EvaluationResponse>();
  for (const [index, line] of content.split("\n").entries()) {
    if (line.length === 0) {
      continue;
    }
    try {
      const response = evaluationResponseSchema.parse(JSON.parse(line));
      const previous = responses.get(response.evaluation_id);
      if (previous !== undefined && previous.status !== "infra_failed") {
        throw new Error(
          `evaluation ${response.evaluation_id} has multiple records after a terminal quality outcome`,
        );
      }
      responses.set(response.evaluation_id, response);
      history.push(response);
    } catch (error) {
      throw new Error(`invalid evaluation journal record on line ${index + 1}`, {
        cause: error,
      });
    }
  }
  return history;
}

export async function readEvaluationJournalHistory(path: string): Promise<EvaluationResponse[]> {
  return readEvaluationJournalRecords(path);
}

export async function readEvaluationJournal(
  path: string,
): Promise<Map<string, EvaluationResponse>> {
  const responses = new Map<string, EvaluationResponse>();
  for (const response of await readEvaluationJournalRecords(path)) {
    responses.set(response.evaluation_id, response);
  }
  return responses;
}

async function discardIncompleteTrailingRecord(path: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (content.length === 0 || content.endsWith("\n")) {
    return;
  }
  const lastCompleteRecord = content.lastIndexOf("\n");
  await truncate(
    path,
    lastCompleteRecord < 0 ? 0 : Buffer.byteLength(content.slice(0, lastCompleteRecord + 1)),
  );
}

class EvaluationTimeoutError extends Error {}

async function executeWithTimeout(
  request: EvaluationRequest,
  execute: EvaluationExecutor,
): Promise<EvaluationResponse> {
  const controller = new AbortController();
  if (request.timeout_ms === undefined) {
    return execute(request, { signal: controller.signal });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new EvaluationTimeoutError("evaluation exceeded its wall-time limit"));
    }, request.timeout_ms);
  });
  try {
    return await Promise.race([execute(request, { signal: controller.signal }), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function infrastructureResponse(
  request: EvaluationRequest,
  startedAt: string,
  finishedAt: string,
  category: "evaluator.timeout" | "evaluator.crashed" | "evaluator.protocol_error",
  message: string,
): EvaluationResponse {
  return evaluationResponseSchema.parse({
    protocol_version: EVALUATION_PROTOCOL_VERSION,
    evaluation_id: request.evaluation_id,
    candidate: candidateIdentity(request.candidate),
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
    duration_ms: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
  });
}

function verifyResponse(request: EvaluationRequest, response: EvaluationResponse): void {
  if (response.evaluation_id !== request.evaluation_id) {
    throw new Error("evaluator response does not match the evaluation ID");
  }
  if (digestJson(response.evaluator) !== digestJson(request.evaluator)) {
    throw new Error("evaluator response does not match the requested evaluator identity");
  }
  if (digestJson(response.suite) !== digestJson(request.suite)) {
    throw new Error("evaluator response does not match the requested suite");
  }
  if (digestJson(response.candidate) !== digestJson(candidateIdentity(request.candidate))) {
    throw new Error("evaluator response does not match the requested candidate");
  }
  if (response.status !== "infra_failed") {
    const returnedMetrics = new Set(response.scores.map((score) => score.metric_id));
    const missingMetrics = request.requested_metrics.filter(
      (metricId) => !returnedMetrics.has(metricId),
    );
    if (missingMetrics.length > 0) {
      throw new Error(`evaluator response omitted requested metrics: ${missingMetrics.join(", ")}`);
    }
  }
}

export async function evaluateCandidates(
  options: EvaluationRunOptions,
): Promise<EvaluationRunResult> {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("evaluation concurrency must be a positive integer");
  }
  const requests = options.candidates.map((candidate) => buildRequest(candidate, options));
  if (new Set(requests.map((request) => request.evaluation_id)).size !== requests.length) {
    throw new Error("evaluation candidates contain duplicate semantic identities");
  }

  await discardIncompleteTrailingRecord(options.journalPath);
  const previous = await readEvaluationJournal(options.journalPath);
  const responseById = new Map<string, EvaluationResponse>();
  const pending: EvaluationRequest[] = [];
  let resumed = 0;
  for (const request of requests) {
    const prior = previous.get(request.evaluation_id);
    const reusable =
      prior !== undefined &&
      (prior.status !== "infra_failed" || options.retryInfrastructureFailures !== true);
    if (reusable) {
      verifyResponse(request, prior);
      responseById.set(request.evaluation_id, prior);
      resumed += 1;
    } else {
      pending.push(request);
    }
  }

  await mkdir(dirname(options.journalPath), { recursive: true });
  let appendChain = Promise.resolve();
  const appendResponse = async (response: EvaluationResponse): Promise<void> => {
    appendChain = appendChain.then(() =>
      appendFile(options.journalPath, `${JSON.stringify(response)}\n`, {
        encoding: "utf8",
        flag: "a",
      }),
    );
    await appendChain;
  };

  const now = options.now ?? (() => new Date().toISOString());
  const queue = new PQueue({ concurrency });
  await Promise.all(
    pending.map((request) =>
      queue.add(async () => {
        const startedAt = now();
        let response: EvaluationResponse;
        try {
          const untrustedResponse = await executeWithTimeout(request, options.execute);
          try {
            response = evaluationResponseSchema.parse(untrustedResponse);
            verifyResponse(request, response);
          } catch {
            response = infrastructureResponse(
              request,
              startedAt,
              now(),
              "evaluator.protocol_error",
              "evaluator returned an invalid or mismatched response",
            );
          }
        } catch (error) {
          const finishedAt = now();
          response = infrastructureResponse(
            request,
            startedAt,
            finishedAt,
            error instanceof EvaluationTimeoutError ? "evaluator.timeout" : "evaluator.crashed",
            error instanceof EvaluationTimeoutError
              ? "evaluator exceeded its wall-time limit"
              : "evaluator execution failed",
          );
        }
        verifyResponse(request, response);
        await appendResponse(response);
        responseById.set(request.evaluation_id, response);
        return response;
      }),
    ),
  );

  const responses = requests.map((request) => {
    const response = responseById.get(request.evaluation_id);
    if (!response) {
      throw new Error(`evaluation ${request.evaluation_id} has no response`);
    }
    return response;
  });
  return { responses, executed: pending.length, resumed };
}
