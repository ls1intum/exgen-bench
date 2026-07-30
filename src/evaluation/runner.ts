import { createReadStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
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

export interface EvaluationExecutor {
  (request: EvaluationRequest, context: EvaluationExecutionContext): Promise<EvaluationResponse>;
  managesTimeout?: boolean;
}

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

const JOURNAL_RECORD_MAXIMUM_BYTES = 16 * 1024 * 1024;

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

async function readEvaluationJournalState(path: string): Promise<{
  history: EvaluationResponse[];
  responses: Map<string, EvaluationResponse>;
}> {
  let stream: ReturnType<typeof createReadStream>;
  try {
    const file = await open(path, "r");
    await file.close();
    stream = createReadStream(path, { encoding: "utf8" });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return { history: [], responses: new Map() };
    }
    throw error;
  }

  const history: EvaluationResponse[] = [];
  const responses = new Map<string, EvaluationResponse>();
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    try {
      if (Buffer.byteLength(line) > JOURNAL_RECORD_MAXIMUM_BYTES) {
        throw new Error(`record exceeds ${JOURNAL_RECORD_MAXIMUM_BYTES} bytes`);
      }
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
      throw new Error(`invalid evaluation journal record on line ${lineNumber}`, {
        cause: error,
      });
    }
  }
  return { history, responses };
}

export async function readEvaluationJournalHistory(path: string): Promise<EvaluationResponse[]> {
  return (await readEvaluationJournalState(path)).history;
}

export async function readEvaluationJournal(
  path: string,
): Promise<Map<string, EvaluationResponse>> {
  return (await readEvaluationJournalState(path)).responses;
}

async function discardIncompleteTrailingRecord(path: string): Promise<void> {
  let file: Awaited<ReturnType<typeof open>>;
  try {
    file = await open(path, "r+");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  try {
    const { size } = await file.stat();
    if (size === 0) {
      return;
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunk.byteLength);
      const length = end - start;
      const { bytesRead } = await file.read(chunk, 0, length, start);
      for (let index = bytesRead - 1; index >= 0; index -= 1) {
        if (chunk[index] === 0x0a) {
          if (start + index + 1 < size) {
            await file.truncate(start + index + 1);
            await file.sync();
          }
          return;
        }
      }
      end = start;
    }
    await file.truncate(0);
    await file.sync();
  } finally {
    await file.close();
  }
}

export class EvaluationTimeoutError extends Error {}
export class EvaluationRecoveryPendingError extends Error {}

async function executeWithTimeout(
  request: EvaluationRequest,
  execute: EvaluationExecutor,
): Promise<EvaluationResponse> {
  const controller = new AbortController();
  if (request.timeout_ms === undefined || execute.managesTimeout === true) {
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
  const journal = await open(options.journalPath, "a");
  let appendChain = Promise.resolve();
  const appendResponse = async (response: EvaluationResponse): Promise<void> => {
    const record = `${JSON.stringify(response)}\n`;
    if (Buffer.byteLength(record) > JOURNAL_RECORD_MAXIMUM_BYTES) {
      throw new Error(`evaluation journal record exceeds ${JOURNAL_RECORD_MAXIMUM_BYTES} bytes`);
    }
    appendChain = appendChain.then(async () => {
      await journal.writeFile(record, "utf8");
      await journal.sync();
    });
    await appendChain;
  };

  const now = options.now ?? (() => new Date().toISOString());
  const queue = new PQueue({ concurrency });
  try {
    const results = await Promise.allSettled(
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
            if (error instanceof EvaluationRecoveryPendingError) {
              throw error;
            }
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
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} evaluations failed unexpectedly`);
    }
  } finally {
    await appendChain.catch(() => undefined);
    await journal.close();
  }

  const responses = requests.map((request) => {
    const response = responseById.get(request.evaluation_id);
    if (!response) {
      throw new Error(`evaluation ${request.evaluation_id} has no response`);
    }
    return response;
  });
  return { responses, executed: pending.length, resumed };
}
