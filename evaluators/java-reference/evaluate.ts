import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluationRequest, EvaluationScore } from "../../src/evaluation/contracts.ts";
import { loadReferenceSet, snapshotReferenceBundle } from "../../src/data/reference-set.ts";
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

interface GoldenReference {
  solution: BundleFile[];
}

async function loadReferenceSuite(referenceSetPath: string) {
  const referenceSet = await loadReferenceSet(referenceSetPath);
  const references = new Map<string, GoldenReference>();
  const temporary = await mkdtemp(join(tmpdir(), "exgen-reference-snapshot-"));
  try {
    for (const item of referenceSet.cases) {
      const snapshot = join(temporary, item.manifest.id);
      const verified = await snapshotReferenceBundle(
        item.bundlePath,
        snapshot,
        `reference-set bundle for ${item.manifest.id}`,
      );
      if (verified.bundleDigest !== item.manifest.bundle_digest) {
        throw new Error(`reference-set bundle changed while loading case ${item.manifest.id}`);
      }
      const bundle = await readCandidateBundle(snapshot);
      if (bundle.solution.length > 0) {
        references.set(item.manifest.id, { solution: bundle.solution });
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return { manifest: referenceSet.manifest, references };
}

export function concatenateJava(files: BundleFile[]): string {
  return javaFiles(files)
    .map((file) => file.content)
    .join("\n");
}

export function createReferenceEvaluator(referenceSetPath: string) {
  const referenceSuite = loadReferenceSuite(referenceSetPath);
  return async (request: EvaluationRequest): Promise<EvaluationOutcome> => {
    const loadedReferenceSet = await referenceSuite;
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
    const bundle = await readCandidateBundle(request.candidate.bundle_path);
    const reference = loadedReferenceSet.references.get(request.candidate.case_id) ?? null;
    const deferred: EvaluationScore[] = [
      notApplicable(
        "reference.golden_tests_on_generated_pass_rate",
        REFERENCE_METRIC_VERSION,
        "golden tests are sealed suite assets; differential testing requires an isolated backend",
      ),
      notApplicable(
        "reference.generated_tests_on_golden_pass_rate",
        REFERENCE_METRIC_VERSION,
        "differential testing requires an isolated backend",
      ),
      notApplicable(
        "reference.statement_embedding_similarity",
        REFERENCE_METRIC_VERSION,
        "no embedding model is configured for this evaluator",
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
