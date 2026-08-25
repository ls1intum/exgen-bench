import type { EvaluationRequest, EvaluationScore } from "../../src/evaluation/contracts.ts";
import { loadReferenceSet, type LoadedReferenceSet } from "../../src/data/reference-set.ts";
import { javaFiles, readCandidateBundle, type BundleFile } from "../shared/bundle.ts";
import { tokenizeJava } from "../shared/java/lexer.ts";
import { notApplicable, score, type EvaluationOutcome } from "../shared/protocol.ts";
import { codeBleu } from "./codebleu.ts";
import { normalisedTreeEditDistance, structureTree } from "./tree.ts";

export const REFERENCE_METRIC_VERSION = "1";

export const REFERENCE_METRICS = [
  "reference.codebleu",
  "reference.ast_edit_distance",
  "reference.golden_tests_on_generated_pass_rate",
  "reference.generated_tests_on_golden_pass_rate",
  "reference.statement_embedding_similarity",
] as const;

/**
 * A golden reference for one case: the same four artifacts, held as a **restricted** suite asset.
 *
 * Acquiring the real golden set is I4 and Phase 3. Until then this evaluator emits `not_applicable`
 * for every case, which is the state the whole pipeline has to survive for the first three phases --
 * so it is exercised from day one rather than discovered later.
 */
export interface GoldenReference {
  solution: BundleFile[];
  tests: BundleFile[];
}

export async function loadGoldenReference(
  referenceSetPath: string,
  caseId: string,
): Promise<GoldenReference | null> {
  return goldenReference(await loadReferenceSet(referenceSetPath), caseId);
}

async function goldenReference(
  referenceSet: LoadedReferenceSet,
  caseId: string,
): Promise<GoldenReference | null> {
  const item = referenceSet.cases.find((candidate) => candidate.manifest.id === caseId);
  if (item === undefined) return null;
  const bundle = await readCandidateBundle(item.bundlePath);
  if (bundle.solution.length === 0) return null;
  return { solution: bundle.solution, tests: bundle.tests };
}

/** Concatenate a set of Java files in path order into one comparable source. */
export function concatenateJava(files: BundleFile[]): string {
  return javaFiles(files)
    .map((file) => file.content)
    .join("\n");
}

/**
 * Reference-based similarity between a candidate and its golden reference.
 *
 * The two execution-based reference metrics -- golden tests against the generated solution, and
 * generated tests against the golden solution -- are declared here and always `not_applicable`. They
 * are not merely unimplemented: golden tests are sealed suite assets, and pushing them through the
 * LocalCI backend would put them inside the system under test. They need the container backend
 * (WP2c) and land in WP10, and the score message says exactly that rather than leaving a reader to
 * infer that the metric simply failed.
 */
export function createReferenceEvaluator(referenceSetPath: string) {
  const referenceSet = loadReferenceSet(referenceSetPath);
  return async (request: EvaluationRequest): Promise<EvaluationOutcome> => {
    const bundle = await readCandidateBundle(request.candidate.bundle_path);
    const loadedReferenceSet = await referenceSet;
    const expectedSuite = {
      id: loadedReferenceSet.manifest.package.id,
      version: loadedReferenceSet.manifest.package.version,
      digest: loadedReferenceSet.manifest.digest,
    };
    if (
      request.suite.id !== expectedSuite.id ||
      request.suite.version !== expectedSuite.version ||
      request.suite.digest !== expectedSuite.digest
    ) {
      throw new Error(
        `evaluation suite does not match reference set ${expectedSuite.id}@${expectedSuite.version} (${expectedSuite.digest})`,
      );
    }
    const reference = await goldenReference(loadedReferenceSet, request.candidate.case_id);
    const deferred: EvaluationScore[] = [
      notApplicable(
        "reference.golden_tests_on_generated_pass_rate",
        REFERENCE_METRIC_VERSION,
        "golden tests are sealed suite assets and must not enter Artemis; differential testing needs the container backend (WP2c)",
      ),
      notApplicable(
        "reference.generated_tests_on_golden_pass_rate",
        REFERENCE_METRIC_VERSION,
        "differential testing needs the container backend (WP2c)",
      ),
      notApplicable(
        "reference.statement_embedding_similarity",
        REFERENCE_METRIC_VERSION,
        "embedding similarity is deferred with the model-based work (decision D6)",
      ),
    ];

    if (reference === null) {
      const reason = `no golden reference exists for case ${request.candidate.case_id}`;
      return {
        gate: null,
        scores: [
          notApplicable("reference.codebleu", REFERENCE_METRIC_VERSION, reason),
          notApplicable("reference.ast_edit_distance", REFERENCE_METRIC_VERSION, reason),
          ...deferred,
        ],
      };
    }

    const candidateSource = concatenateJava(bundle.solution);
    const referenceSource = concatenateJava(reference.solution);
    const similarity = codeBleu(candidateSource, referenceSource);
    const distance = normalisedTreeEditDistance(
      structureTree(tokenizeJava(candidateSource).tokens),
      structureTree(tokenizeJava(referenceSource).tokens),
    );
    const evidence = [
      `reference:${request.candidate.case_id}`,
      ...Object.entries(similarity.components).map(
        ([component, value]) => `${component}:${value.toFixed(6)}`,
      ),
    ];
    return {
      gate: null,
      scores: [
        score("reference.codebleu", REFERENCE_METRIC_VERSION, similarity.score, { evidence }),
        score("reference.ast_edit_distance", REFERENCE_METRIC_VERSION, distance, { evidence }),
        ...deferred,
      ],
    };
  };
}
