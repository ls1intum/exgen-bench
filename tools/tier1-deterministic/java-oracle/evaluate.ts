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
  type CatalogTest,
  readTestCatalog,
  TEST_LANES,
  type TestLane,
  testLane,
} from "../../kit/test-catalog.ts";
import {
  type BuildBackend,
  type BuildOutcome,
  passesEveryTest,
  passRate,
  type SubmissionBuild,
} from "./backend.ts";
import { summariseMutants } from "./mutation.ts";

export const ORACLE_METRIC_VERSION = "2";
export const BYPASS_METRIC_VERSION = "3";

export const ORACLE_METRICS = [
  "build.template_compiles",
  "build.solution_compiles",
  "tests.executable",
  "tests.count",
  "oracle.solution_pass_rate",
  "oracle.template_pass_rate",
  "oracle.satisfied",
  "oracle.gradable_satisfied",
  "oracle.template_pass_rate_gradable",
  "oracle.template_pass_rate_structural",
  "oracle.template_pass_rate_preservation",
  "oracle.output_only_bypass",
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

/**
 * The lane of every test a build reported, from the candidate's Artemis test catalog, or why the
 * lanes are unknown. Unknown lanes fail closed: no lane-aware metric is computed from a guess.
 */
export type LaneAssignment = { lanes: Map<string, TestLane> } | { unavailable: string };

export function assignLanes(outcome: BuildOutcome, catalog: CatalogTest[] | null): LaneAssignment {
  if (catalog === null) {
    return {
      unavailable:
        "the candidate carries no Artemis test catalog to tell gradable from structural and preservation tests",
    };
  }
  const lanes = new Map<string, TestLane>();
  const unknown: string[] = [];
  const ambiguous: string[] = [];
  for (const test of catalog) {
    const lane = testLane(test);
    if (lane === null) unknown.push(test.name);
    else if (lanes.has(test.name) && lanes.get(test.name) !== lane) ambiguous.push(test.name);
    else lanes.set(test.name, lane);
  }
  if (unknown.length > 0) {
    return {
      unavailable: `the test catalog gives no type, weight, bonus points or visibility for ${unknown.join(", ")}`,
    };
  }
  if (ambiguous.length > 0) {
    return { unavailable: `the test catalog puts ${ambiguous.join(", ")} in more than one lane` };
  }
  const unlisted = [
    ...new Set(
      [...outcome.solution.test_cases, ...outcome.template.test_cases]
        .map((testCase) => testCase.name)
        .filter((name) => !lanes.has(name)),
    ),
  ];
  if (unlisted.length > 0) {
    return {
      unavailable: `${unlisted.length} executed tests are not in the test catalog: ${unlisted.slice(0, 8).join(", ")}`,
    };
  }
  return { lanes };
}

/**
 * The gate of evaluation design v2 (#57): the solution passes every test, and the template passes
 * no gradable test. Structural and preservation tests may pass on the template by design.
 */
export function gradableVerdict(
  outcome: BuildOutcome,
  lanes: Map<string, TestLane>,
): OracleVerdict {
  const reasons = oracleVerdict(outcome).reasons.filter(
    (reason) => !reason.startsWith("the template already passes"),
  );
  const gradable = [...lanes].filter(([, lane]) => lane === "gradable").map(([name]) => name);
  if (gradable.length === 0) reasons.push("the exercise declares no gradable test");
  const ran = new Set(outcome.solution.test_cases.map((testCase) => testCase.name));
  const missing = gradable.filter((name) => !ran.has(name));
  if (missing.length > 0) {
    reasons.push(
      `gradable tests did not run against the solution: ${missing.slice(0, 8).join(", ")}`,
    );
  }
  const passing = outcome.template.test_cases.filter(
    (testCase) => testCase.passed && lanes.get(testCase.name) === "gradable",
  );
  if (passing.length > 0) {
    reasons.push(
      `the template already passes ${passing.length} gradable tests: ${passing
        .slice(0, 8)
        .map((testCase) => testCase.name)
        .join(", ")}`,
    );
  }
  return { satisfied: reasons.length === 0, reasons };
}

export function laneScores(outcome: BuildOutcome, assignment: LaneAssignment): EvaluationScore[] {
  const laneMetric = (lane: TestLane) => `oracle.template_pass_rate_${lane}`;
  if ("unavailable" in assignment) {
    return ["oracle.gradable_satisfied", ...TEST_LANES.map(laneMetric)].map((metricId) =>
      notApplicable(metricId, ORACLE_METRIC_VERSION, assignment.unavailable),
    );
  }
  const verdict = gradableVerdict(outcome, assignment.lanes);
  return [
    {
      metric_id: "oracle.gradable_satisfied",
      metric_version: ORACLE_METRIC_VERSION,
      status: "ok" as const,
      value: verdict.satisfied,
      ...(verdict.satisfied ? {} : { message: verdict.reasons.join("; ") }),
      evidence: [],
    },
    ...TEST_LANES.map((lane) => {
      const cases = outcome.template.test_cases.filter(
        (testCase) => assignment.lanes.get(testCase.name) === lane,
      );
      if (!outcome.template.tests_executed || cases.length === 0) {
        return notApplicable(
          laneMetric(lane),
          ORACLE_METRIC_VERSION,
          outcome.template.tests_executed
            ? `the template build reported no ${lane} test`
            : "the test suite did not run against the template",
        );
      }
      const passed = cases.filter((testCase) => testCase.passed);
      return score(laneMetric(lane), ORACLE_METRIC_VERSION, passed.length / cases.length, {
        numerator: passed.length,
        denominator: cases.length,
        evidence: boundedEvidence(passed.map((testCase) => `passes:${testCase.name}`)),
      });
    }),
  ];
}

/**
 * Whether the solution, with one tested `main` reduced to printing its own transcript, still passes
 * every gradable test. True means the gradable tests cannot tell a program from its printed output.
 */
export function bypassScore(outcome: BuildOutcome, assignment: LaneAssignment): EvaluationScore {
  const metricId = "oracle.output_only_bypass";
  const run = outcome.bypass;
  if (run === undefined) {
    return notApplicable(
      metricId,
      BYPASS_METRIC_VERSION,
      !outcome.template.compiled || !passesEveryTest(outcome.solution)
        ? "the bypass probe needs a template that compiles and a solution that passes every test"
        : `the ${outcome.attestation.backend_id} backend does not run the bypass probe`,
    );
  }
  if (run.status !== "measured") {
    const message = run.reason ?? "the bypass probe did not run";
    return run.status === "failed"
      ? {
          metric_id: metricId,
          metric_version: BYPASS_METRIC_VERSION,
          status: "infra_failure",
          message,
          evidence: [],
        }
      : notApplicable(metricId, BYPASS_METRIC_VERSION, message);
  }
  if ("unavailable" in assignment) {
    return notApplicable(metricId, BYPASS_METRIC_VERSION, assignment.unavailable);
  }
  const gradable = [...assignment.lanes]
    .filter(([, lane]) => lane === "gradable")
    .map(([name]) => name);
  if (gradable.length === 0) {
    return notApplicable(metricId, BYPASS_METRIC_VERSION, "the exercise declares no gradable test");
  }
  // Only tests that ran on the solution can say anything about the bypass. A gradable test that was
  // skipped, disabled or aborted by an assumption would otherwise count as detecting it.
  const ranOnSolution = new Set(outcome.solution.test_cases.map((testCase) => testCase.name));
  const neverRan = gradable.filter((name) => !ranOnSolution.has(name));
  if (neverRan.length > 0) {
    return notApplicable(
      metricId,
      BYPASS_METRIC_VERSION,
      `gradable tests did not run on the solution: ${neverRan.slice(0, 8).join(", ")}`,
    );
  }
  // A gradable test the solution ran but the bypass build did not report says nothing about the
  // bypass: the run was cut short. Counting it as detecting the bypass would report a reassuring
  // false from an incomplete build.
  const reported = new Map(run.test_cases.map((testCase) => [testCase.name, testCase.passed]));
  const unreported = gradable.filter((name) => !reported.has(name));
  if (unreported.length > 0) {
    return {
      metric_id: metricId,
      metric_version: BYPASS_METRIC_VERSION,
      status: "infra_failure",
      message: `the bypass build did not report ${unreported.length} gradable tests the solution ran: ${unreported.slice(0, 8).join(", ")}`,
      evidence: [],
    };
  }
  const silent = new Map(
    run.silent_test_cases?.map((testCase) => [testCase.name, testCase.passed]),
  );
  const missingScope = gradable.filter((name) => !silent.has(name));
  if (missingScope.length > 0) {
    return {
      metric_id: metricId,
      metric_version: BYPASS_METRIC_VERSION,
      status: "infra_failure",
      message: `empty-main grading scope is missing for ${missingScope.slice(0, 8).join(", ")}; old recordings need a separately identified reevaluation`,
      evidence: [],
    };
  }
  if (gradable.every((name) => silent.get(name) === true)) {
    return notApplicable(
      metricId,
      BYPASS_METRIC_VERSION,
      "every gradable test passes an empty main; the selected entry point is ungraded",
    );
  }
  const passed = new Set([...reported].filter(([, ok]) => ok).map(([name]) => name));
  const failing = gradable.filter((name) => !passed.has(name));
  return score(metricId, BYPASS_METRIC_VERSION, failing.length === 0, {
    numerator: gradable.length - failing.length,
    denominator: gradable.length,
    evidence: boundedEvidence([
      `main:${run.main_class ?? "unknown"}`,
      `transcript_characters:${run.transcript_characters}`,
      ...gradable.filter((name) => silent.get(name) === false).map((name) => `observed_by:${name}`),
      ...failing.map((name) => `detected_by:${name}`),
    ]),
  });
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
    `mutators:${[...new Set(run.mutants.map((mutant) => mutant.mutator))].sort().join(",")}`,
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

export function assembleScores(
  outcome: BuildOutcome,
  verdict: OracleVerdict,
  lanes: LaneAssignment = assignLanes(outcome, null),
): EvaluationScore[] {
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
    ...laneScores(outcome, lanes),
    bypassScore(outcome, lanes),
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
    let lanes: LaneAssignment;
    try {
      lanes = assignLanes(outcome, await readTestCatalog(request.candidate.bundle_path));
    } catch (error) {
      lanes = {
        unavailable: `the candidate's test catalog is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    return {
      gate: { metricId: "oracle.satisfied", satisfied: verdict.satisfied },
      ...(verdict.satisfied ? {} : { failureCategory: gateFailureCategory(outcome) }),
      scores: assembleScores(outcome, verdict, lanes),
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
