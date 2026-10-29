import type { EvaluationRequest } from "../../../src/evaluation/contracts.ts";
import { readCandidateBundle } from "../../kit/bundle.ts";
import { boundedEvidence, type EvaluationOutcome, score } from "../../kit/protocol.ts";
import { findFlaws, type FlawFinding, type FlawReport } from "./flaws.ts";

export const FLAWS_METRIC_VERSION = "1";

export const FLAWS_METRICS = [
  "tests.assertions_without_message",
  "flaws.exact_float_assertions",
  "flaws.replayed_examples",
  "flaws.undefined_labels",
] as const;

function evidence(findings: FlawFinding[]): string[] {
  return boundedEvidence(findings.map((finding) => `${finding.file}: ${finding.detail}`));
}

/**
 * The item-writing-flaw evaluator. It counts flaws and decides nothing: it has no acceptance gate, so
 * its `strict_success` only records that the candidate was measured.
 */
export function flawsOutcome(report: FlawReport): EvaluationOutcome {
  return {
    gate: null,
    scores: [
      score(
        "tests.assertions_without_message",
        FLAWS_METRIC_VERSION,
        report.assertionsWithoutMessage.length,
        {
          ...(report.assertions > 0
            ? { numerator: report.assertionsWithoutMessage.length, denominator: report.assertions }
            : {}),
          evidence: evidence(report.assertionsWithoutMessage),
        },
      ),
      score(
        "flaws.exact_float_assertions",
        FLAWS_METRIC_VERSION,
        report.exactFloatAssertions.length,
        { evidence: evidence(report.exactFloatAssertions) },
      ),
      score("flaws.replayed_examples", FLAWS_METRIC_VERSION, report.replayedExamples.length, {
        evidence: evidence(report.replayedExamples),
      }),
      score("flaws.undefined_labels", FLAWS_METRIC_VERSION, report.undefinedLabels.length, {
        evidence: evidence(report.undefinedLabels),
      }),
    ],
  };
}

export async function evaluateFlaws(request: EvaluationRequest): Promise<EvaluationOutcome> {
  const bundle = await readCandidateBundle(request.candidate.bundle_path);
  return flawsOutcome(
    findFlaws({ statement: bundle.statement, template: bundle.template, tests: bundle.tests }),
  );
}
