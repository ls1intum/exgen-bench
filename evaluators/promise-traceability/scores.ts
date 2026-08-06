import type { EvaluationScore } from "../../src/evaluation/contracts.ts";
import type { ModelLayerOutcome } from "./model.ts";
import type { TraceabilityReport } from "./traceability.ts";

export const METRIC_VERSION = "1";

export const DETERMINISTIC_METRICS = [
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

export const MODEL_ASSISTED_METRICS = [
  "promise.model_claims",
  "promise.model_unwitnessed_claims",
  "promise.model_witnessed_ratio",
] as const;

const MAXIMUM_EVIDENCE_ENTRIES = 48;
const MAXIMUM_EVIDENCE_CHARACTERS = 240;

function evidence(lines: string[]): string[] {
  const kept = lines
    .filter((line) => line.trim() !== "")
    .map((line) =>
      line.length > MAXIMUM_EVIDENCE_CHARACTERS
        ? `${line.slice(0, MAXIMUM_EVIDENCE_CHARACTERS - 1)}…`
        : line,
    );
  return kept.length > MAXIMUM_EVIDENCE_ENTRIES
    ? [
        ...kept.slice(0, MAXIMUM_EVIDENCE_ENTRIES - 1),
        `… ${kept.length - MAXIMUM_EVIDENCE_ENTRIES + 1} further entries omitted`,
      ]
    : kept;
}

function ratio(
  metricId: string,
  numerator: number,
  denominator: number,
  emptyDenominator: string,
  lines: string[],
): EvaluationScore {
  if (denominator === 0) {
    return {
      metric_id: metricId,
      metric_version: METRIC_VERSION,
      status: "not_applicable",
      message: emptyDenominator,
      evidence: [],
    };
  }
  return {
    metric_id: metricId,
    metric_version: METRIC_VERSION,
    status: "ok",
    value: Number((numerator / denominator).toFixed(6)),
    numerator,
    denominator,
    evidence: evidence(lines),
  };
}

function scalar(metricId: string, value: number | boolean, lines: string[]): EvaluationScore {
  return {
    metric_id: metricId,
    metric_version: METRIC_VERSION,
    status: "ok",
    value,
    evidence: evidence(lines),
  };
}

export function claimTable(report: TraceabilityReport): string[] {
  return report.claims.map((claim) => {
    const name = claim.detail === undefined ? claim.kind : `${claim.kind}:${claim.detail}`;
    const mark = claim.witnessed ? "witnessed" : "UNEXERCISED";
    return `${mark} ${name} — "${claim.text}" — ${claim.witness}`;
  });
}

function deterministicScore(
  metricId: string,
  report: TraceabilityReport,
): EvaluationScore | undefined {
  const witnessed = report.claims.filter((claim) => claim.witnessed);
  const unwitnessed = report.claims.filter((claim) => !claim.witnessed);
  const exceptions = report.claims.filter((claim) => claim.kind === "exception");
  const witnessedLiterals = report.literals.filter((literal) => literal.witnessed);
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
        claimTable(report).filter((line) => line.startsWith("UNEXERCISED")),
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
            `${claim.witnessed ? "witnessed" : "UNEXERCISED"} ${claim.detail} — ${claim.witness}`,
        ),
      );
    case "boundary.literal_ratio":
      return ratio(
        metricId,
        witnessedLiterals.length,
        report.literals.length,
        "the statement names no boundary literal",
        report.literals.map(
          (literal) => `${literal.witnessed ? "present" : "ABSENT"} ${literal.kind} ${literal.raw}`,
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
        ? {
            metric_id: metricId,
            metric_version: METRIC_VERSION,
            status: "not_applicable",
            message: "the suite has no behavioural test method",
            evidence: [],
          }
        : scalar(metricId, Number((report.assertions / report.behaviouralMethods).toFixed(6)), []);
    case "tests.assertionless_methods":
      return scalar(metricId, report.assertionlessMethods.length, report.assertionlessMethods);
    case "tests.structural_lane_present":
      return scalar(metricId, report.structuralLanePresent, []);
    default:
      return undefined;
  }
}

function modelScore(
  metricId: string,
  model: Extract<ModelLayerOutcome, { status: "ok" }>,
): EvaluationScore | undefined {
  const unwitnessed = model.claims.filter((claim) => !claim.witnessed);
  const lines = model.claims.map(
    (claim) =>
      `${claim.witnessed ? "witnessed" : "UNEXERCISED"} ${claim.claim} — ${claim.rationale}`,
  );
  switch (metricId) {
    case "promise.model_claims":
      return scalar(metricId, model.claims.length, lines);
    case "promise.model_unwitnessed_claims":
      return scalar(
        metricId,
        unwitnessed.length,
        lines.filter((line) => line.startsWith("UNEXERCISED")),
      );
    case "promise.model_witnessed_ratio":
      return ratio(
        metricId,
        model.claims.length - unwitnessed.length,
        model.claims.length,
        "the model extracted no normative claim",
        lines,
      );
    default:
      return undefined;
  }
}

export function buildScores(
  requestedMetrics: string[],
  report: TraceabilityReport,
  model: ModelLayerOutcome | undefined,
): EvaluationScore[] {
  return requestedMetrics.map((metricId) => {
    const deterministic = deterministicScore(metricId, report);
    if (deterministic !== undefined) {
      return deterministic;
    }
    if ((MODEL_ASSISTED_METRICS as readonly string[]).includes(metricId)) {
      if (model === undefined) {
        return {
          metric_id: metricId,
          metric_version: METRIC_VERSION,
          status: "not_applicable" as const,
          message: "the exploratory model-assisted layer is disabled; pass --model to enable it",
          evidence: [],
        };
      }
      if (model.status === "failed") {
        return {
          metric_id: metricId,
          metric_version: METRIC_VERSION,
          status: "infra_failure" as const,
          message: model.message,
          evidence: [],
        };
      }
      const score = modelScore(metricId, model);
      if (score !== undefined) {
        return score;
      }
    }
    return {
      metric_id: metricId,
      metric_version: METRIC_VERSION,
      status: "not_applicable" as const,
      message: `${metricId} is not produced by the promise-traceability evaluator`,
      evidence: [],
    };
  });
}
