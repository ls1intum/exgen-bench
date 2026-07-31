import { describe, expect, test } from "bun:test";
import { pairedCaseBootstrap } from "../analysis/paired-bootstrap.ts";
import { buildAnalysisRecords } from "../src/export/analysis.ts";
import type { EvaluationResponse } from "../src/evaluation/contracts.ts";
import type { GenerationObservation } from "../src/evaluation/summary.ts";

function evaluation(
  attemptId: string,
  systemId: string,
  caseId: string,
  replicate: number,
  strictSuccess: boolean,
): EvaluationResponse {
  return {
    protocol_version: "1",
    evaluation_id: `${attemptId.charCodeAt(0).toString(16)}`.padEnd(64, "0"),
    candidate: {
      experiment_id: "experiment",
      attempt_id: attemptId,
      generation_key: "a".repeat(64),
      case_id: caseId,
      system_id: systemId,
      replicate,
      artifact_digest: "b".repeat(64),
    },
    evaluator: {
      id: "evaluator",
      version: "1",
      revision: "revision",
      target_profile: "generic",
      implementation_digest: "c".repeat(64),
    },
    suite: { id: "suite", version: "1", digest: "d".repeat(64) },
    status: strictSuccess ? "succeeded" : "quality_failed",
    strict_success: strictSuccess,
    ...(strictSuccess ? {} : { failure_category: "tests.failed" as const }),
    scores: [],
    started_at: "2026-07-30T00:00:00.000Z",
    finished_at: "2026-07-30T00:00:01.000Z",
    duration_ms: 1000,
  };
}

describe("analysis-ready records", () => {
  test("preserves paired case and replicate identities", () => {
    const generations: GenerationObservation[] = [
      ["a1", "case-1", "a", 1],
      ["b1", "case-1", "b", 1],
      ["a1r2", "case-1", "a", 2],
      ["b1r2", "case-1", "b", 2],
      ["a2", "case-2", "a", 1],
      ["b2", "case-2", "b", 1],
      ["a2r2", "case-2", "a", 2],
      ["b2r2", "case-2", "b", 2],
    ].map(([attemptId, caseId, systemId, replicate]) => ({
      attempt_id: String(attemptId),
      case_id: String(caseId),
      system_id: String(systemId),
      replicate: Number(replicate),
      seed: 42,
      state: "completed",
      outcome: "succeeded",
      error_code: null,
      started_at: "2026-07-30T00:00:00.000Z",
      finished_at: "2026-07-30T00:00:01.000Z",
      generation_key: "a".repeat(64),
      artifact_digest: "b".repeat(64),
      evidence_digest: "c".repeat(64),
      budget_status: "compliant",
      budget_violations: [],
      budget_missing: [],
      generation_duration_ms: 1000,
      model_calls: 1,
      tool_calls: 0,
      input_tokens: 100,
      output_tokens: 200,
      total_tokens: 300,
      cost_amount: null,
      cost_currency: null,
    }));
    const evaluations = [
      evaluation("a1", "a", "case-1", 1, true),
      evaluation("b1", "b", "case-1", 1, false),
      evaluation("a1r2", "a", "case-1", 2, true),
      evaluation("b1r2", "b", "case-1", 2, false),
      evaluation("a2", "a", "case-2", 1, true),
      evaluation("b2", "b", "case-2", 1, true),
      evaluation("a2r2", "a", "case-2", 2, true),
      evaluation("b2r2", "b", "case-2", 2, true),
    ];
    const records = buildAnalysisRecords(generations, evaluations);
    expect(records.pairs).toHaveLength(4);
    expect(records.systems.find((system) => system.system_id === "a")).toMatchObject({
      strict_successes: 4,
      evaluator_strict_successes: 4,
      quality_outcomes: 4,
    });

    const result = pairedCaseBootstrap(records.pairs, { seed: 42, resamples: 200 });
    expect(result.observed_difference).toBe(0.5);
    expect(result.cases).toBe(2);
    expect(result.complete_attempt_pairs).toBe(4);
    expect(pairedCaseBootstrap(records.pairs, { seed: 42, resamples: 200 })).toEqual(result);
  });

  test("does not count evaluator acceptance without compliant budget evidence", () => {
    const generation: GenerationObservation = {
      attempt_id: "a1",
      case_id: "case-1",
      system_id: "a",
      replicate: 1,
      seed: 42,
      state: "completed",
      outcome: "succeeded",
      error_code: null,
      started_at: "2026-07-30T00:00:00.000Z",
      finished_at: "2026-07-30T00:00:01.000Z",
      generation_key: "a".repeat(64),
      artifact_digest: "b".repeat(64),
      evidence_digest: "c".repeat(64),
      budget_status: "exceeded",
      budget_violations: ["total_tokens:301>300"],
      budget_missing: [],
      generation_duration_ms: 1000,
      model_calls: 1,
      tool_calls: 0,
      input_tokens: 100,
      output_tokens: 201,
      total_tokens: 301,
      cost_amount: null,
      cost_currency: null,
    };
    const records = buildAnalysisRecords([generation], [evaluation("a1", "a", "case-1", 1, true)]);
    expect(records.attempts[0]).toMatchObject({
      evaluator_strict_success: true,
      strict_success: false,
      generation_budget_status: "exceeded",
    });
    expect(records.systems[0]).toMatchObject({
      evaluator_strict_successes: 1,
      strict_successes: 0,
    });
  });
});
