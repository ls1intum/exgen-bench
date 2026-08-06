import { describe, expect, test } from "bun:test";
import type { EvaluationResponse, EvaluationScore } from "../src/evaluation/contracts.ts";
import {
  resolveAuthoritativeEvaluatorId,
  summarizeEvaluation,
  type GenerationObservation,
} from "../src/evaluation/summary.ts";
import { buildAnalysisRecords } from "../src/export/analysis.ts";

function generation(attemptId: string, caseId: string, systemId: string): GenerationObservation {
  return {
    attempt_id: attemptId,
    case_id: caseId,
    system_id: systemId,
    replicate: 1,
    seed: 7,
    state: "completed",
    outcome: "succeeded",
    error_code: null,
    started_at: "2026-08-06T00:00:00.000Z",
    finished_at: "2026-08-06T00:00:01.000Z",
    experiment_id: "experiment",
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
  };
}

let evaluationCounter = 0;

function evaluation(
  attemptId: string,
  evaluatorId: string,
  strictSuccess: boolean | null,
  scores: EvaluationScore[] = [],
): EvaluationResponse {
  evaluationCounter += 1;
  return {
    protocol_version: "1",
    evaluation_id: evaluationCounter.toString(16).padStart(64, "0"),
    candidate: {
      experiment_id: "experiment",
      attempt_id: attemptId,
      generation_key: "a".repeat(64),
      case_id: attemptId.startsWith("a") ? "case-1" : "case-2",
      system_id: "system-a",
      replicate: 1,
      artifact_digest: "b".repeat(64),
    },
    evaluator: {
      id: evaluatorId,
      version: "1",
      revision: "revision",
      target_profile: "artemis-java-maven",
      implementation_digest: "c".repeat(64),
    },
    suite: { id: `${evaluatorId}-suite`, version: "1", digest: "d".repeat(64) },
    status:
      strictSuccess === null ? "infra_failed" : strictSuccess ? "succeeded" : "quality_failed",
    strict_success: strictSuccess,
    ...(strictSuccess === true
      ? {}
      : {
          failure_category:
            strictSuccess === null
              ? ("infrastructure.unavailable" as const)
              : ("tests.failed" as const),
        }),
    scores,
    started_at: "2026-08-06T00:00:02.000Z",
    finished_at: "2026-08-06T00:00:03.000Z",
    duration_ms: 1000,
  };
}

function score(
  metricId: string,
  status: EvaluationScore["status"],
  value?: number | boolean | string,
): EvaluationScore {
  return {
    metric_id: metricId,
    metric_version: "1",
    status,
    ...(value === undefined ? {} : { value }),
    evidence: [],
  };
}

const generations = [
  generation("a1", "case-1", "system-a"),
  generation("b1", "case-2", "system-a"),
];

describe("authoritative evaluator resolution", () => {
  test("defaults to the only evaluator present", () => {
    expect(resolveAuthoritativeEvaluatorId([evaluation("a1", "java-oracle", true)])).toBe(
      "java-oracle",
    );
    expect(resolveAuthoritativeEvaluatorId([])).toBeNull();
  });

  test("requires a declaration once several evaluators cover the same candidate", () => {
    const evaluations = [
      evaluation("a1", "java-oracle", true),
      evaluation("a1", "java-static", true),
    ];
    expect(() => resolveAuthoritativeEvaluatorId(evaluations)).toThrow(/must declare which one/);
    expect(resolveAuthoritativeEvaluatorId(evaluations, "java-static")).toBe("java-static");
  });

  test("rejects a declaration that produced no evaluation", () => {
    expect(() =>
      resolveAuthoritativeEvaluatorId([evaluation("a1", "java-oracle", true)], "llm-judge"),
    ).toThrow(/no evaluation was produced/);
  });
});

describe("several evaluators over one candidate", () => {
  test("summarises without tripping the one-evaluation-per-attempt rule", () => {
    const summary = summarizeEvaluation(
      generations,
      [
        evaluation("a1", "java-oracle", true),
        evaluation("a1", "java-static", false),
        evaluation("a1", "java-reference", true),
        evaluation("b1", "java-oracle", false),
        evaluation("b1", "java-static", true),
        evaluation("b1", "java-reference", true),
      ],
      { authoritativeEvaluatorId: "java-oracle" },
    );
    expect(summary.authoritative_evaluator_id).toBe("java-oracle");
    expect(summary.denominators.evaluation_records).toBe(6);
    expect(summary.denominators.evaluated).toBe(2);
    expect(summary.denominators.strict_successes).toBe(1);
    expect(summary.rates.evaluation_coverage_over_generated).toBe(1);
    expect(summary.evaluators.map((entry) => entry.evaluator_id)).toEqual([
      "java-oracle",
      "java-reference",
      "java-static",
    ]);
    expect(summary.evaluators.find((entry) => entry.authoritative)?.evaluator_id).toBe(
      "java-oracle",
    );
    expect(
      summary.evaluators.find((entry) => entry.evaluator_id === "java-static")?.strict_successes,
    ).toBe(1);
  });

  test("still rejects one evaluator producing two evaluations for one attempt", () => {
    expect(() =>
      summarizeEvaluation(generations, [
        evaluation("a1", "java-oracle", true),
        evaluation("a1", "java-oracle", false),
      ]),
    ).toThrow(/more than one evaluation for attempt a1/);
  });

  test("an infrastructure failure of a secondary evaluator does not remove a quality outcome", () => {
    const summary = summarizeEvaluation(
      generations,
      [
        evaluation("a1", "java-oracle", true),
        evaluation("a1", "java-reference", null),
        evaluation("b1", "java-oracle", true),
        evaluation("b1", "java-reference", null),
      ],
      { authoritativeEvaluatorId: "java-oracle" },
    );
    expect(summary.denominators.quality_outcomes).toBe(2);
    expect(summary.missingness.evaluation_infra_failures).toBe(0);
    expect(
      summary.evaluators.find((entry) => entry.evaluator_id === "java-reference")
        ?.infrastructure_failures,
    ).toBe(2);
    expect(summary.evaluation_failures["infrastructure.unavailable"]).toBe(2);
  });
});

describe("not_applicable propagation", () => {
  test("an entirely inapplicable metric does not report a misleading zero", () => {
    const summary = summarizeEvaluation(
      generations,
      [
        evaluation("a1", "java-oracle", true, [score("oracle.satisfied", "ok", true)]),
        evaluation("b1", "java-oracle", true, [score("oracle.satisfied", "ok", true)]),
        evaluation("a1", "java-reference", true, [score("reference.codebleu", "not_applicable")]),
        evaluation("b1", "java-reference", true, [score("reference.codebleu", "not_applicable")]),
      ],
      { authoritativeEvaluatorId: "java-oracle" },
    );
    const reference = summary.metrics_conditional_on_strict_success.find(
      (metric) => metric.metric_id === "reference.codebleu",
    );
    expect(reference).toMatchObject({
      evaluator_id: "java-reference",
      available: 0,
      not_applicable: 2,
      missing: 0,
      applicable_denominator: 0,
      numeric_mean: null,
    });
  });

  test("a partly applicable metric averages over the cases where it applies", () => {
    const summary = summarizeEvaluation(
      generations,
      [
        evaluation("a1", "java-oracle", true),
        evaluation("b1", "java-oracle", true),
        evaluation("a1", "java-reference", true, [score("reference.codebleu", "ok", 0.8)]),
        evaluation("b1", "java-reference", true, [score("reference.codebleu", "not_applicable")]),
      ],
      { authoritativeEvaluatorId: "java-oracle" },
    );
    const reference = summary.metrics_conditional_on_strict_success.find(
      (metric) => metric.metric_id === "reference.codebleu",
    );
    expect(reference).toMatchObject({
      available: 1,
      not_applicable: 1,
      missing: 0,
      applicable_denominator: 1,
      numeric_mean: 0.8,
    });
  });

  test("a genuinely absent score is missing rather than not applicable", () => {
    const summary = summarizeEvaluation(
      generations,
      [
        evaluation("a1", "java-oracle", true, [score("coverage.statement", "ok", 0.5)]),
        evaluation("b1", "java-oracle", true, []),
      ],
      { authoritativeEvaluatorId: "java-oracle" },
    );
    expect(
      summary.metrics_conditional_on_strict_success.find(
        (metric) => metric.metric_id === "coverage.statement",
      ),
    ).toMatchObject({ available: 1, not_applicable: 0, missing: 1, applicable_denominator: 2 });
  });

  test("keeps metrics of the same name apart when two evaluators emit them", () => {
    const summary = summarizeEvaluation(
      generations,
      [
        evaluation("a1", "java-oracle", true, [score("tests.count", "ok", 10)]),
        evaluation("b1", "java-oracle", true, [score("tests.count", "ok", 20)]),
        evaluation("a1", "java-reference", true, [score("tests.count", "ok", 4)]),
        evaluation("b1", "java-reference", true, [score("tests.count", "ok", 6)]),
      ],
      { authoritativeEvaluatorId: "java-oracle" },
    );
    const summaries = summary.metrics_conditional_on_strict_success.filter(
      (metric) => metric.metric_id === "tests.count",
    );
    expect(summaries).toHaveLength(2);
    expect(summaries.find((entry) => entry.evaluator_id === "java-oracle")?.numeric_mean).toBe(15);
    expect(summaries.find((entry) => entry.evaluator_id === "java-reference")?.numeric_mean).toBe(
      5,
    );
  });
});

describe("analysis records with several evaluators", () => {
  const evaluations = [
    evaluation("a1", "java-oracle", true, [score("oracle.satisfied", "ok", true)]),
    evaluation("a1", "java-static", false, [score("concept.missing", "ok", "requires_loop")]),
    evaluation("b1", "java-oracle", false, [score("oracle.satisfied", "ok", false)]),
    evaluation("b1", "java-static", true, [score("concept.missing", "ok", "")]),
  ];

  test("the wide attempt row follows the authoritative evaluator only", () => {
    const records = buildAnalysisRecords(generations, evaluations, {
      authoritativeEvaluatorId: "java-oracle",
    });
    expect(records.attempts).toHaveLength(2);
    expect(records.attempts.find((row) => row.attempt_id === "a1")?.strict_success).toBe(true);
    expect(records.attempts.find((row) => row.attempt_id === "b1")?.strict_success).toBe(false);

    const flipped = buildAnalysisRecords(generations, evaluations, {
      authoritativeEvaluatorId: "java-static",
    });
    expect(flipped.attempts.find((row) => row.attempt_id === "a1")?.strict_success).toBe(false);
    expect(flipped.attempts.find((row) => row.attempt_id === "b1")?.strict_success).toBe(true);
  });

  test("scores stay attributable to the evaluator that produced them", () => {
    const records = buildAnalysisRecords(generations, evaluations, {
      authoritativeEvaluatorId: "java-oracle",
    });
    expect(records.scores).toHaveLength(4);
    expect(new Set(records.scores.map((row) => row.evaluator_id))).toEqual(
      new Set(["java-oracle", "java-static"]),
    );
    expect(
      records.scores.find((row) => row.attempt_id === "a1" && row.evaluator_id === "java-static")
        ?.metric_id,
    ).toBe("concept.missing");
  });

  test("emits one normalised row per attempt and evaluator", () => {
    const records = buildAnalysisRecords(generations, evaluations, {
      authoritativeEvaluatorId: "java-oracle",
    });
    expect(records.evaluations).toHaveLength(4);
    expect(records.evaluations.filter((row) => row.authoritative)).toHaveLength(2);
    expect(
      records.evaluations.find(
        (row) => row.attempt_id === "a1" && row.evaluator_id === "java-static",
      ),
    ).toMatchObject({
      authoritative: false,
      evaluation_status: "quality_failed",
      evaluator_strict_success: false,
      evaluation_failure: "tests.failed",
      suite_id: "java-static-suite",
    });
  });

  test("system summaries count each attempt once, not once per evaluator", () => {
    const records = buildAnalysisRecords(generations, evaluations, {
      authoritativeEvaluatorId: "java-oracle",
    });
    expect(records.systems).toHaveLength(1);
    expect(records.systems[0]).toMatchObject({
      system_id: "system-a",
      planned: 2,
      evaluated: 2,
      quality_outcomes: 2,
      strict_successes: 1,
    });
  });
});
