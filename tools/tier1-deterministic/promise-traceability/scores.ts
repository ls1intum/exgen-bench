import type { EvaluationScore } from "../../../src/evaluation/contracts.ts";
import { boundedEvidence, notApplicable, score } from "../../kit/protocol.ts";
import type { TraceabilityReport } from "./traceability.ts";

export const METRIC_VERSION = "1";

export const TRACEABILITY_METRICS = [
  "promise.witnessed_ratio",
  "promise.unwitnessed_claims",
  "promise.unclassified_normative_units",
  "api.member_reference_ratio",
  "exception.assertthrows_ratio",
  "boundary.literal_ratio",
  "tests.behavioural_methods",
  "tests.assertions",
  "tests.assertion_density",
  "tests.assertionless_methods",
  "tests.structural_lane_present",
] as const;

function ratio(
  metricId: string,
  numerator: number,
  denominator: number,
  emptyDenominator: string,
  lines: string[],
): EvaluationScore {
  return denominator === 0
    ? notApplicable(metricId, METRIC_VERSION, emptyDenominator)
    : score(metricId, METRIC_VERSION, Number((numerator / denominator).toFixed(6)), {
        numerator,
        denominator,
        evidence: boundedEvidence(lines),
      });
}

function scalar(metricId: string, value: number | boolean, lines: string[]): EvaluationScore {
  return score(metricId, METRIC_VERSION, value, { evidence: boundedEvidence(lines) });
}

function claimTable(report: TraceabilityReport): string[] {
  return report.claims.map((claim) => {
    const name = claim.detail === undefined ? claim.kind : `${claim.kind}:${claim.detail}`;
    const mark = claim.witnessed ? "witnessed" : "UNWITNESSED";
    return `${mark} ${name} — "${claim.text}" — ${claim.witness}`;
  });
}

function traceabilityScore(
  metricId: string,
  report: TraceabilityReport,
): EvaluationScore | undefined {
  const witnessed = report.claims.filter((claim) => claim.witnessed);
  const unwitnessed = report.claims.filter((claim) => !claim.witnessed);
  const exceptions = report.claims.filter((claim) => claim.kind === "exception");
  const presentLiterals = report.literals.filter((literal) => literal.present);
  const referenced = report.members.filter((member) => member.referenced);

  switch (metricId) {
    case "promise.witnessed_ratio":
      return ratio(
        metricId,
        witnessed.length,
        report.claims.length,
        "the statement declares no classifiable normative claim",
        claimTable(report),
      );
    case "promise.unwitnessed_claims":
      return scalar(
        metricId,
        unwitnessed.length,
        claimTable(report).filter((line) => line.startsWith("UNWITNESSED")),
      );
    case "promise.unclassified_normative_units":
      return scalar(
        metricId,
        report.unclassifiedNormativeUnits.length,
        report.unclassifiedNormativeUnits,
      );
    case "api.member_reference_ratio":
      return ratio(
        metricId,
        referenced.length,
        report.members.length,
        "the statement declares no public API member",
        report.members.map(
          (member) => `${member.referenced ? "referenced" : "UNREFERENCED"} ${member.name}`,
        ),
      );
    case "exception.assertthrows_ratio":
      return ratio(
        metricId,
        exceptions.filter((claim) => claim.witnessed).length,
        exceptions.length,
        "the statement names no exception behaviour",
        exceptions.map(
          (claim) =>
            `${claim.witnessed ? "witnessed" : "UNWITNESSED"} ${claim.detail} — ${claim.witness}`,
        ),
      );
    case "boundary.literal_ratio":
      return ratio(
        metricId,
        presentLiterals.length,
        report.literals.length,
        "the statement names no boundary literal",
        report.literals.map(
          (literal) => `${literal.present ? "present" : "ABSENT"} ${literal.kind} ${literal.raw}`,
        ),
      );
    case "tests.behavioural_methods":
      return scalar(metricId, report.behaviouralMethods, [
        `${report.structuralMethods} structural test methods excluded`,
      ]);
    case "tests.assertions":
      return scalar(metricId, report.assertions, []);
    case "tests.assertion_density":
      return report.behaviouralMethods === 0
        ? notApplicable(metricId, METRIC_VERSION, "the suite has no behavioural test method")
        : scalar(metricId, Number((report.assertions / report.behaviouralMethods).toFixed(6)), []);
    case "tests.assertionless_methods":
      return scalar(metricId, report.assertionlessMethods.length, report.assertionlessMethods);
    case "tests.structural_lane_present":
      return scalar(metricId, report.structuralLanePresent, []);
    default:
      return undefined;
  }
}

export function buildScores(
  requestedMetrics: string[],
  report: TraceabilityReport,
): EvaluationScore[] {
  return requestedMetrics.map(
    (metricId) =>
      traceabilityScore(metricId, report) ??
      notApplicable(
        metricId,
        METRIC_VERSION,
        `${metricId} is not produced by the promise-traceability evaluator`,
      ),
  );
}
