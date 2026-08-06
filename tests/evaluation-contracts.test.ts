import { describe, expect, test } from "bun:test";
import { evaluationResponseSchema, evaluationScoreSchema } from "../src/evaluation/contracts.ts";
import type { EvaluationResponse } from "../src/evaluation/contracts.ts";
import { type GenerationObservation, summarizeEvaluation } from "../src/evaluation/summary.ts";
import { buildAnalysisRecords } from "../src/export/analysis.ts";

describe("evaluation protocol contracts", () => {
  test("requires strict success to agree with the terminal status", () => {
    const base = {
      protocol_version: "1",
      evaluation_id: "a".repeat(64),
      candidate: {
        experiment_id: "experiment",
        attempt_id: "attempt",
        generation_key: "b".repeat(64),
        case_id: "case",
        system_id: "system",
        replicate: 1,
        artifact_digest: "c".repeat(64),
      },
      evaluator: {
        id: "test-evaluator",
        version: "1.0.0",
        revision: "revision",
        target_profile: "generic",
        implementation_digest: "d".repeat(64),
      },
      suite: { id: "suite", version: "1.0.0", digest: "e".repeat(64) },
      scores: [],
      started_at: "2026-07-30T00:00:00.000Z",
      finished_at: "2026-07-30T00:00:01.000Z",
      duration_ms: 1000,
    };
    expect(
      evaluationResponseSchema.safeParse({
        ...base,
        status: "succeeded",
        strict_success: false,
      }).success,
    ).toBeFalse();
    expect(
      evaluationResponseSchema.safeParse({
        ...base,
        status: "infra_failed",
        strict_success: null,
        failure_category: "infrastructure.unavailable",
      }).success,
    ).toBeTrue();
  });

  test("does not permit an available score without a value", () => {
    expect(
      evaluationScoreSchema.safeParse({
        metric_id: "tests.pass_rate",
        metric_version: "1",
        status: "ok",
        evidence: [],
      }).success,
    ).toBeFalse();
    expect(
      evaluationScoreSchema.safeParse({
        metric_id: "tests.pass_rate",
        metric_version: "1",
        status: "not_applicable",
        evidence: [],
      }).success,
    ).toBeTrue();
  });
});

describe("candidate selection and the strict-success invariant", () => {
  const observation = (
    overrides: Partial<GenerationObservation> & Pick<GenerationObservation, "attempt_id">,
  ): GenerationObservation => ({
    case_id: "case-1",
    system_id: "system-a",
    replicate: 1,
    seed: 1,
    state: "completed",
    outcome: "succeeded",
    error_code: null,
    experiment_id: "experiment",
    started_at: "2026-07-30T00:00:00.000Z",
    finished_at: "2026-07-30T00:00:01.000Z",
    generation_key: "b".repeat(64),
    artifact_digest: "c".repeat(64),
    evidence_digest: "d".repeat(64),
    budget_status: "compliant",
    budget_violations: [],
    budget_missing: [],
    generation_duration_ms: 1000,
    model_calls: null,
    tool_calls: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cost_amount: null,
    cost_currency: null,
    ...overrides,
  });

  const acceptance = (attemptId: string, caseId = "case-1"): EvaluationResponse =>
    evaluationResponseSchema.parse({
      protocol_version: "1",
      evaluation_id: "a".repeat(64),
      candidate: {
        experiment_id: "experiment",
        attempt_id: attemptId,
        generation_key: "b".repeat(64),
        case_id: caseId,
        system_id: "system-a",
        replicate: 1,
        artifact_digest: "c".repeat(64),
      },
      evaluator: {
        id: "test-evaluator",
        version: "1.0.0",
        revision: "revision",
        target_profile: "generic",
        implementation_digest: "d".repeat(64),
      },
      suite: { id: "suite", version: "1.0.0", digest: "e".repeat(64) },
      status: "succeeded",
      strict_success: true,
      scores: [],
      started_at: "2026-07-30T00:00:00.000Z",
      finished_at: "2026-07-30T00:00:01.000Z",
      duration_ms: 1000,
    });

  test("scores a retained candidate from a generation the system did not accept", () => {
    const generations = [observation({ attempt_id: "attempt-1", outcome: "failed" })];

    const summary = summarizeEvaluation(generations, [acceptance("attempt-1")]);
    const records = buildAnalysisRecords(generations, [acceptance("attempt-1")]);

    expect(summary.denominators.candidates).toBe(1);
    expect(summary.denominators.evaluated).toBe(1);
    expect(records.attempts[0]?.evaluator_strict_success).toBeTrue();
  });

  test("never counts an accepted candidate from a failed generation as a strict success", () => {
    const generations = [observation({ attempt_id: "attempt-1", outcome: "failed" })];
    const evaluations = [acceptance("attempt-1")];

    const summary = summarizeEvaluation(generations, evaluations);
    const records = buildAnalysisRecords(generations, evaluations);

    expect(summary.denominators.evaluator_strict_successes).toBe(1);
    expect(summary.denominators.strict_successes).toBe(0);
    expect(summary.rates.end_to_end_strict_success_over_planned).toBe(0);
    expect(records.attempts[0]?.strict_success).toBeFalse();
    expect(records.systems[0]?.strict_successes).toBe(0);
  });

  test("still counts an accepted candidate from a succeeded generation", () => {
    const generations = [observation({ attempt_id: "attempt-1" })];
    const evaluations = [acceptance("attempt-1")];

    expect(summarizeEvaluation(generations, evaluations).denominators.strict_successes).toBe(1);
    expect(buildAnalysisRecords(generations, evaluations).attempts[0]?.strict_success).toBeTrue();
  });

  test("keeps evaluation coverage within one when a failed generation is scored", () => {
    const generations = [
      observation({ attempt_id: "attempt-1", outcome: "failed" }),
      observation({ attempt_id: "attempt-2", case_id: "case-2" }),
    ];
    const evaluations = [acceptance("attempt-1"), acceptance("attempt-2", "case-2")];

    const summary = summarizeEvaluation(generations, evaluations);
    const records = buildAnalysisRecords(generations, evaluations);

    expect(summary.denominators.generated_candidates).toBe(1);
    expect(summary.denominators.candidates).toBe(2);
    expect(summary.rates.evaluation_coverage_over_candidates).toBe(1);
    expect(records.systems[0]?.evaluation_coverage).toBe(1);
  });

  test("rejects an evaluation of an attempt that produced no candidate", () => {
    const generations = [
      observation({ attempt_id: "attempt-1", outcome: "failed", artifact_digest: null }),
    ];

    expect(() => summarizeEvaluation(generations, [acceptance("attempt-1")])).toThrow(
      "evaluation references attempt without a candidate",
    );
  });
});
