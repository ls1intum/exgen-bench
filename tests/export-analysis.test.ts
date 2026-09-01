import { describe, expect, test } from "bun:test";
import { pairedCaseBootstrap, pairedClusteredObservations } from "../analysis/paired-bootstrap.ts";
import type { GenerationObservation } from "../src/evaluation/summary.ts";
import { buildAnalysisRecords } from "../src/export/analysis.ts";
import { evaluationResponse, generationObservation } from "./fixtures/evaluation.ts";

function evaluation(
  attemptId: string,
  systemId: string,
  caseId: string,
  replicate: number,
  strictSuccess: boolean,
) {
  return evaluationResponse({
    evaluation_id: `${attemptId.charCodeAt(0).toString(16)}`.padEnd(64, "0"),
    status: strictSuccess ? "succeeded" : "quality_failed",
    candidate: {
      attempt_id: attemptId,
      case_id: caseId,
      system_id: systemId,
      replicate,
      generation_key: "a".repeat(64),
      artifact_digest: "b".repeat(64),
    },
  });
}

function generation(
  attemptId: string,
  systemId: string,
  caseId: string,
  replicate: number,
  overrides: Partial<GenerationObservation> = {},
): GenerationObservation {
  return generationObservation({
    attempt_id: attemptId,
    case_id: caseId,
    system_id: systemId,
    replicate,
    seed: 42,
    generation_key: "a".repeat(64),
    artifact_digest: "b".repeat(64),
    evidence_digest: "c".repeat(64),
    model_calls: 1,
    tool_calls: 0,
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
    ...overrides,
  });
}

describe("analysis-ready records", () => {
  test("preserves paired case and replicate identities", () => {
    const identities = [
      ["a1", "case-1", "a", 1],
      ["b1", "case-1", "b", 1],
      ["a1r2", "case-1", "a", 2],
      ["b1r2", "case-1", "b", 2],
      ["a2", "case-2", "a", 1],
      ["b2", "case-2", "b", 1],
      ["a2r2", "case-2", "a", 2],
      ["b2r2", "case-2", "b", 2],
    ] as const;
    const generations = identities.map(([attemptId, caseId, systemId, replicate]) =>
      generation(attemptId, systemId, caseId, replicate),
    );
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

    const observations = pairedClusteredObservations(records.pairs);
    expect(observations).toHaveLength(8);
    expect(observations.filter((row) => row.cluster_id === "case-1")).toHaveLength(4);
    expect(observations.filter((row) => row.cluster_id === "case-2")).toHaveLength(4);
    expect(observations.filter((row) => row.treatment === 1)).toHaveLength(4);
    expect(observations.filter((row) => row.treatment === 0)).toHaveLength(4);
  });

  test("excludes an incomplete pair from the clustered observations", () => {
    const records = buildAnalysisRecords(
      [generation("a1", "a", "case-1", 1), generation("a2", "a", "case-2", 1)],
      [evaluation("a1", "a", "case-1", 1, true)],
    );
    expect(records.pairs.filter((row) => row.pair_complete)).toHaveLength(0);
    expect(pairedClusteredObservations(records.pairs)).toEqual([]);
  });

  test("does not count evaluator acceptance without compliant budget evidence", () => {
    const records = buildAnalysisRecords(
      [
        generation("a1", "a", "case-1", 1, {
          budget_status: "exceeded",
          budget_violations: ["total_tokens:301>300"],
          output_tokens: 201,
          total_tokens: 301,
        }),
      ],
      [evaluation("a1", "a", "case-1", 1, true)],
    );

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

  test("does not count evaluator acceptance of a candidate the system did not accept", () => {
    const generations = [generation("a1", "a", "case-1", 1, { outcome: "failed" })];

    const records = buildAnalysisRecords(generations, [evaluation("a1", "a", "case-1", 1, true)]);

    expect(records.attempts[0]).toMatchObject({
      evaluator_strict_success: true,
      strict_success: false,
    });
    expect(records.systems[0]).toMatchObject({
      candidates: 1,
      generated: 0,
      strict_successes: 0,
      evaluation_coverage: 1,
    });
  });

  test("conditions the strict-success rate on the population its numerator is drawn from", () => {
    const generations = [
      generation("a1", "a", "case-1", 1),
      generation("a2", "a", "case-2", 1, { outcome: "failed" }),
      generation("a3", "a", "case-3", 1),
    ];
    const evaluations = [
      evaluation("a1", "a", "case-1", 1, true),
      evaluation("a2", "a", "case-2", 1, true),
      evaluation("a3", "a", "case-3", 1, false),
    ];

    const records = buildAnalysisRecords(generations, evaluations);

    expect(records.systems[0]).toMatchObject({
      quality_outcomes: 3,
      evaluator_strict_successes: 2,
      strict_successes: 1,
      conditional_strict_success_rate: 1 / 2,
    });
  });

  test("reports a pair as having both quality outcomes only when both were accepted", () => {
    const generations = [
      generation("a1", "a", "case-1", 1),
      generation("b1", "b", "case-1", 1, { outcome: "failed" }),
    ];
    const evaluations = [
      evaluation("a1", "a", "case-1", 1, true),
      evaluation("b1", "b", "case-1", 1, true),
    ];

    const records = buildAnalysisRecords(generations, evaluations);

    expect(records.pairs[0]).toMatchObject({
      strict_success_a: 1,
      strict_success_b: 0,
      quality_outcome_available_a: true,
      quality_outcome_available_b: false,
    });
    const result = pairedCaseBootstrap(records.pairs, { seed: 42, resamples: 50 });
    expect(result.pairs_with_both_quality_outcomes).toBe(0);
    expect(result.observed_difference).toBe(1);
  });
});
