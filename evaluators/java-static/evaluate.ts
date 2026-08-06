import type { EvaluationRequest, EvaluationScore } from "../../src/evaluation/contracts.ts";
import { readCandidateBundle } from "../shared/bundle.ts";
import { unitComplexity } from "../shared/java/complexity.ts";
import { notApplicable, score, type EvaluationOutcome } from "../shared/protocol.ts";
import {
  CONSTRUCTS,
  detectConstructsInFiles,
  loadConstructSpec,
  type Construct,
  type ConstructSpec,
} from "./spec.ts";

export const STATIC_METRIC_VERSION = "1";

export const STATIC_METRICS = [
  "concept.required_constructs_present",
  "concept.forbidden_constructs_absent",
  "concept.missing",
  "concept.missing_count",
  "concept.violated_count",
  "complexity.cyclomatic_max",
  "complexity.cognitive_max",
  "complexity.within_bounds",
] as const;

/** The public vocabulary of `concept.missing`: the closed construct set plus an explicit "none". */
export const CONCEPT_MISSING_VALUES = ["none", ...CONSTRUCTS] as const;

export interface StaticFindings {
  missing: Construct[];
  violated: Construct[];
  cyclomaticMax: number;
  cognitiveMax: number;
  withinBounds: boolean;
  complexityViolations: string[];
}

export function evaluateAgainstSpec(
  spec: ConstructSpec,
  present: Set<Construct>,
  cyclomaticMax: number,
  cognitiveMax: number,
): StaticFindings {
  const missing = spec.required_constructs.filter((construct) => !present.has(construct)).sort();
  const violated = spec.forbidden_constructs.filter((construct) => present.has(construct)).sort();
  const complexityViolations: string[] = [];
  if (
    spec.complexity.max_cyclomatic !== undefined &&
    cyclomaticMax > spec.complexity.max_cyclomatic
  ) {
    complexityViolations.push(
      `cyclomatic complexity ${cyclomaticMax} exceeds the declared maximum ${spec.complexity.max_cyclomatic}`,
    );
  }
  if (spec.complexity.max_cognitive !== undefined && cognitiveMax > spec.complexity.max_cognitive) {
    complexityViolations.push(
      `cognitive complexity ${cognitiveMax} exceeds the declared maximum ${spec.complexity.max_cognitive}`,
    );
  }
  return {
    missing,
    violated,
    cyclomaticMax,
    cognitiveMax,
    withinBounds: complexityViolations.length === 0,
    complexityViolations,
  };
}

/**
 * Concept fidelity and complexity fit, from the candidate bundle alone.
 *
 * No Artemis, no execution, no independence question: this evaluator reads the generated Java and
 * compares what it finds against the case's construct spec. Where no spec exists -- which is every
 * case until WP9 -- every concept metric is `not_applicable` rather than absent or false, so the
 * pipeline stays green and the aggregate denominator stays honest.
 *
 * Complexity is measured whether or not a spec exists, because it needs no ground truth; only the
 * *bound* needs one.
 */
export function createStaticEvaluator(suiteDirectory: string) {
  return async (request: EvaluationRequest): Promise<EvaluationOutcome> => {
    const bundle = await readCandidateBundle(request.candidate.bundle_path);
    const { constructs, units, unparsed } = detectConstructsInFiles(bundle.solution);
    const complexities = units.flatMap((unit) => unitComplexity(unit));
    const cyclomaticMax = complexities.reduce(
      (highest, entry) => Math.max(highest, entry.cyclomatic),
      0,
    );
    const cognitiveMax = complexities.reduce(
      (highest, entry) => Math.max(highest, entry.cognitive),
      0,
    );
    const evidence = [
      ...units.map((unit) => `solution:${unit.path}`),
      ...unparsed.map((entry) => `unparsed:${entry.path}:${entry.reason}`),
    ];

    const spec = await loadConstructSpec(suiteDirectory, request.candidate.case_id);
    const complexityScores: EvaluationScore[] =
      complexities.length === 0
        ? [
            notApplicable(
              "complexity.cyclomatic_max",
              STATIC_METRIC_VERSION,
              "the candidate solution declares no method body to measure",
            ),
            notApplicable(
              "complexity.cognitive_max",
              STATIC_METRIC_VERSION,
              "the candidate solution declares no method body to measure",
            ),
          ]
        : [
            score("complexity.cyclomatic_max", STATIC_METRIC_VERSION, cyclomaticMax, { evidence }),
            score("complexity.cognitive_max", STATIC_METRIC_VERSION, cognitiveMax, { evidence }),
          ];

    if (spec === null) {
      const reason = `no construct specification exists for case ${request.candidate.case_id}`;
      return {
        gate: null,
        scores: [
          notApplicable("concept.required_constructs_present", STATIC_METRIC_VERSION, reason),
          notApplicable("concept.forbidden_constructs_absent", STATIC_METRIC_VERSION, reason),
          notApplicable("concept.missing", STATIC_METRIC_VERSION, reason),
          notApplicable("concept.missing_count", STATIC_METRIC_VERSION, reason),
          notApplicable("concept.violated_count", STATIC_METRIC_VERSION, reason),
          ...complexityScores,
          notApplicable("complexity.within_bounds", STATIC_METRIC_VERSION, reason),
        ],
      };
    }

    const findings = evaluateAgainstSpec(spec, constructs, cyclomaticMax, cognitiveMax);
    const satisfied =
      findings.missing.length === 0 && findings.violated.length === 0 && findings.withinBounds;
    return {
      gate: { metricId: "concept.required_constructs_present", satisfied },
      scores: [
        score(
          "concept.required_constructs_present",
          STATIC_METRIC_VERSION,
          findings.missing.length === 0,
          { evidence },
        ),
        score(
          "concept.forbidden_constructs_absent",
          STATIC_METRIC_VERSION,
          findings.violated.length === 0,
          { evidence },
        ),
        {
          metric_id: "concept.missing",
          metric_version: STATIC_METRIC_VERSION,
          status: "ok" as const,
          // A closed vocabulary is what makes this publishable as a string metric. When several
          // constructs are missing it names the first in vocabulary order and `concept.missing_count`
          // carries the total; the score message lists them all for a restricted reader.
          value: findings.missing[0] ?? "none",
          ...(findings.missing.length > 1
            ? { message: `missing constructs: ${findings.missing.join(", ")}` }
            : {}),
          evidence,
        },
        score("concept.missing_count", STATIC_METRIC_VERSION, findings.missing.length),
        {
          metric_id: "concept.violated_count",
          metric_version: STATIC_METRIC_VERSION,
          status: "ok" as const,
          value: findings.violated.length,
          ...(findings.violated.length > 0
            ? { message: `forbidden constructs present: ${findings.violated.join(", ")}` }
            : {}),
          evidence,
        },
        ...complexityScores,
        {
          metric_id: "complexity.within_bounds",
          metric_version: STATIC_METRIC_VERSION,
          status: "ok" as const,
          value: findings.withinBounds,
          ...(findings.complexityViolations.length > 0
            ? { message: findings.complexityViolations.join("; ") }
            : {}),
          evidence,
        },
      ],
    };
  };
}
