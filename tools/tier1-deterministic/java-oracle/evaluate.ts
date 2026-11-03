import type { EvaluationRequest, EvaluationScore } from "../../../src/evaluation/contracts.ts";
import { readCandidateBundle } from "../../kit/bundle.ts";
import {
  boundedEvidence,
  type EvaluationOutcome,
  InfrastructureError,
  notApplicable,
  score,
} from "../../kit/protocol.ts";
import {
  type BuildBackend,
  type BuildOutcome,
  passesEveryTest,
  passRate,
  type SubmissionBuild,
} from "./backend.ts";
import { summariseMutants } from "./mutation.ts";

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
  "mutation.covered_survivors",
] as const;

const MAXIMUM_LISTED_SURVIVORS = 24;

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

function mutationUnavailable(message: string, status: "not_applicable" | "infra_failure") {
  return (["mutation.score", "mutation.covered_survivors"] as const).map((metricId) =>
    status === "not_applicable"
      ? notApplicable(metricId, ORACLE_METRIC_VERSION, message)
      : {
          metric_id: metricId,
          metric_version: ORACLE_METRIC_VERSION,
          status,
          message,
          evidence: [],
        },
  );
}

/**
 * The mutation score over the classes the solution changes, and how many of their surviving mutants
 * a test executed. A run that should have produced a report and did not is an infrastructure
 * failure of this metric alone; the oracle verdict does not depend on it.
 */
export function mutationScores(outcome: BuildOutcome): EvaluationScore[] {
  const run = outcome.mutation;
  if (run === undefined) {
    return mutationUnavailable(
      !outcome.template.compiled || !passesEveryTest(outcome.solution)
        ? "mutation analysis needs a template that compiles and a solution that passes every test"
        : `the ${outcome.attestation.backend_id} backend does not run mutation analysis`,
      "not_applicable",
    );
  }
  if (run.status !== "measured") {
    return mutationUnavailable(
      run.reason ?? "mutation analysis did not run",
      run.status === "failed" ? "infra_failure" : "not_applicable",
    );
  }
  const summary = summariseMutants(run.mutants, run.target_classes);
  if (summary.unfinished > 0) {
    return mutationUnavailable(
      `PIT left ${summary.unfinished} mutants of the changed classes unfinished`,
      "infra_failure",
    );
  }
  if (summary.denominator === 0) {
    return mutationUnavailable(
      "PIT generated no viable mutant in the classes the solution changes",
      "not_applicable",
    );
  }
  const simple = (name: string) => name.slice(name.lastIndexOf(".") + 1);
  const evidence = boundedEvidence([
    ...(run.tool === null ? [] : [`tool:${run.tool}`]),
    `classes:${run.target_classes.map(simple).join(",")}`,
    ...Object.entries(summary.counts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([status, count]) => `status:${status}=${count}`),
    ...summary.survivors
      .slice(0, MAXIMUM_LISTED_SURVIVORS)
      .map(
        (mutant) =>
          `survivor:${simple(mutant.class)}.${mutant.method}:${mutant.line} ${mutant.mutator} covered=${mutant.status === "SURVIVED" ? "yes" : "no"}`,
      ),
  ]);
  return [
    score("mutation.score", ORACLE_METRIC_VERSION, summary.killed / summary.denominator, {
      numerator: summary.killed,
      denominator: summary.denominator,
      evidence,
    }),
    score("mutation.covered_survivors", ORACLE_METRIC_VERSION, summary.coveredSurvivors, {
      evidence: boundedEvidence(
        summary.survivors
          .filter((mutant) => mutant.status === "SURVIVED")
          .slice(0, MAXIMUM_LISTED_SURVIVORS)
          .map(
            (mutant) => `${simple(mutant.class)}.${mutant.method}:${mutant.line} ${mutant.mutator}`,
          ),
      ),
    }),
  ];
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
    ...mutationScores(outcome),
  ];
}

/**
 * The recovery half of `createOracleEvaluator`: reconcile or cancel the remote work a killed build
 * left behind, addressed by the same request a replay of this evaluation would use. Backends that
 * start nothing durable (fixture, Maven, Gradle) declare no `recover`, and there is nothing to do.
 */
export function createOracleRecovery(backend: BuildBackend) {
  return async (request: EvaluationRequest): Promise<void> => {
    if (!backend.recover) {
      return;
    }
    const bundle = await readCandidateBundle(request.candidate.bundle_path);
    await backend.recover({ request, bundle }, new AbortController().signal);
  };
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
