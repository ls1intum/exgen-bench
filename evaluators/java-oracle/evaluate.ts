import type { EvaluationRequest, EvaluationScore } from "../../src/evaluation/contracts.ts";
import { readCandidateBundle } from "../shared/bundle.ts";
import {
  type EvaluationOutcome,
  InfrastructureError,
  notApplicable,
  score,
} from "../shared/protocol.ts";
import { type BuildBackend, type BuildOutcome, passRate, type SubmissionBuild } from "./backend.ts";

export const ORACLE_METRIC_VERSION = "1";

export const ORACLE_METRICS = [
  "build.template_compiles",
  "build.solution_compiles",
  "tests.executable",
  "tests.count",
  "oracle.solution_pass_rate",
  "oracle.template_pass_rate",
  "oracle.satisfied",
  "coverage.statement",
  "coverage.branch",
  "mutation.score",
] as const;

export interface OracleVerdict {
  satisfied: boolean;
  reasons: string[];
}

export function oracleVerdict(outcome: BuildOutcome): OracleVerdict {
  const reasons: string[] = [];
  if (!outcome.solution.compiled) {
    reasons.push("the solution does not compile");
  }
  if (!outcome.template.compiled) {
    reasons.push("the template does not compile");
  }
  if (!outcome.solution.tests_executed) {
    reasons.push("the test suite did not run against the solution");
  }
  if (!outcome.template.tests_executed) {
    reasons.push("the test suite did not run against the template");
  }
  const solution = passRate(outcome.solution);
  const template = passRate(outcome.template);
  if (solution.denominator === 0) {
    reasons.push("the exercise declares no test cases");
  }
  if (solution.rate !== null && solution.rate < 1) {
    reasons.push(
      `the solution passes ${solution.numerator} of ${solution.denominator} tests, not all of them`,
    );
  }
  if (template.rate !== null && template.rate > 0) {
    reasons.push(
      `the template already passes ${template.numerator} of ${template.denominator} tests`,
    );
  }
  return { satisfied: reasons.length === 0, reasons };
}

function coverageScores(build: SubmissionBuild): EvaluationScore[] {
  const coverage = build.coverage;
  return (["statement", "branch"] as const).map((dimension) => {
    const value = coverage?.[dimension] ?? null;
    return value === null
      ? notApplicable(
          `coverage.${dimension}`,
          ORACLE_METRIC_VERSION,
          "the build backend reported no coverage for this dimension",
        )
      : score(`coverage.${dimension}`, ORACLE_METRIC_VERSION, value);
  });
}

export function assembleScores(outcome: BuildOutcome, verdict: OracleVerdict): EvaluationScore[] {
  const solution = passRate(outcome.solution);
  const template = passRate(outcome.template);
  const evidence = [
    `backend:${outcome.attestation.backend_id}`,
    ...(outcome.attestation.toolchain === null
      ? []
      : [`toolchain:${outcome.attestation.toolchain}`]),
    ...outcome.solution.diagnostics.slice(0, 8).map((entry) => `solution:${entry}`),
    ...outcome.template.diagnostics.slice(0, 8).map((entry) => `template:${entry}`),
  ];
  return [
    score("build.template_compiles", ORACLE_METRIC_VERSION, outcome.template.compiled),
    score("build.solution_compiles", ORACLE_METRIC_VERSION, outcome.solution.compiled),
    score(
      "tests.executable",
      ORACLE_METRIC_VERSION,
      outcome.solution.tests_executed && outcome.template.tests_executed,
    ),
    score("tests.count", ORACLE_METRIC_VERSION, solution.denominator),
    solution.rate === null
      ? notApplicable(
          "oracle.solution_pass_rate",
          ORACLE_METRIC_VERSION,
          "the exercise declares no test cases",
        )
      : score("oracle.solution_pass_rate", ORACLE_METRIC_VERSION, solution.rate, {
          numerator: solution.numerator,
          denominator: solution.denominator,
        }),
    template.rate === null
      ? notApplicable(
          "oracle.template_pass_rate",
          ORACLE_METRIC_VERSION,
          "the exercise declares no test cases",
        )
      : score("oracle.template_pass_rate", ORACLE_METRIC_VERSION, template.rate, {
          numerator: template.numerator,
          denominator: template.denominator,
        }),
    {
      metric_id: "oracle.satisfied",
      metric_version: ORACLE_METRIC_VERSION,
      status: "ok" as const,
      value: verdict.satisfied,
      ...(verdict.satisfied ? {} : { message: verdict.reasons.join("; ") }),
      evidence,
    },
    ...coverageScores(outcome.solution),
    notApplicable(
      "mutation.score",
      ORACLE_METRIC_VERSION,
      "mutation testing requires an isolated backend with access to sealed suite assets",
    ),
  ];
}

export function createOracleEvaluator(backend: BuildBackend) {
  return async (request: EvaluationRequest): Promise<EvaluationOutcome> => {
    const bundle = await readCandidateBundle(request.candidate.bundle_path);
    const controller = new AbortController();
    const timeout =
      request.timeout_ms === undefined
        ? undefined
        : setTimeout(() => controller.abort(), request.timeout_ms);
    let outcome: BuildOutcome;
    try {
      outcome = await backend.build({ request, bundle }, controller.signal);
    } catch (error) {
      if (error instanceof InfrastructureError) {
        throw error;
      }
      throw new InfrastructureError(
        `build backend ${backend.id} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
    const verdict = oracleVerdict(outcome);
    return {
      gate: { metricId: "oracle.satisfied", satisfied: verdict.satisfied },
      ...(verdict.satisfied ? {} : { failureCategory: gateFailureCategory(outcome) }),
      scores: assembleScores(outcome, verdict),
    };
  };
}

function gateFailureCategory(
  outcome: BuildOutcome,
): "build.failed" | "tests.failed" | "quality.threshold_not_met" {
  if (!outcome.solution.compiled || !outcome.template.compiled) {
    return "build.failed";
  }
  if (!outcome.solution.tests_executed || !outcome.template.tests_executed) {
    return "tests.failed";
  }
  return "quality.threshold_not_met";
}
