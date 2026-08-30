import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluationResponse } from "../src/evaluation/contracts.ts";
import type { GenerationObservation } from "../src/evaluation/summary.ts";
import { PUBLIC_DISCLOSURE_PROFILE } from "../src/export/disclosure.ts";
import { exportRelease } from "../src/export/release.ts";
import { evaluationResponse, generationObservation } from "./fixtures/evaluation.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const generations: GenerationObservation[] = [
  generationObservation({
    attempt_id: "attempt-a",
    model_calls: 1,
    tool_calls: 0,
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
  }),
  generationObservation({
    attempt_id: "attempt-b",
    system_id: "system-b",
    generation_key: "2".repeat(64),
    artifact_digest: "3".repeat(64),
    evidence_digest: "4".repeat(64),
    model_calls: 1,
    tool_calls: 0,
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
  }),
  generationObservation({
    attempt_id: "attempt-c",
    case_id: "case-2",
    seed: 2,
    state: "planned",
    outcome: null,
    started_at: null,
    finished_at: null,
    generation_key: "5".repeat(64),
    artifact_digest: null,
    evidence_digest: null,
    budget_status: null,
    generation_duration_ms: null,
  }),
];

const evaluations: EvaluationResponse[] = [
  evaluationResponse({
    candidate: { attempt_id: "attempt-a" },
    scores: [
      {
        metric_id: "tests.pass_rate",
        metric_version: "1",
        status: "ok",
        value: 0.8,
        numerator: 8,
        denominator: 10,
        evidence: [],
      },
    ],
  }),
  evaluationResponse({
    evaluation_id: "1".repeat(64),
    status: "quality_failed",
    candidate: {
      attempt_id: "attempt-b",
      system_id: "system-b",
      generation_key: "2".repeat(64),
      artifact_digest: "3".repeat(64),
    },
    scores: [
      {
        metric_id: "tests.pass_rate",
        metric_version: "1",
        status: "quality_failure",
        value: 0.4,
        numerator: 4,
        denominator: 10,
        evidence: [],
      },
    ],
  }),
];

const firstEvaluation = evaluations[0];
const secondEvaluation = evaluations[1];
const firstScore = firstEvaluation?.scores[0];
if (!firstEvaluation || !secondEvaluation || !firstScore) {
  throw new Error("evaluation fixture is empty");
}
const unsafeStringEvaluation: EvaluationResponse = {
  ...firstEvaluation,
  scores: [{ ...firstScore, value: "hidden test: instructor-password" }],
};
const retriedInfrastructureFailure: EvaluationResponse = {
  ...firstEvaluation,
  status: "infra_failed",
  strict_success: null,
  failure_category: "evaluator.timeout",
  scores: [
    {
      metric_id: "tests.pass_rate",
      metric_version: "1",
      status: "infra_failure",
      message: "timed out",
      evidence: ["restricted/evaluator-attempt-1.json"],
    },
  ],
};

async function allFiles(root: string, relative = ""): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry): Promise<string[]> => {
      const path = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
      return entry.isDirectory() ? allFiles(root, path) : [path];
    }),
  );
  return files.flat().sort();
}

describe("publication export", () => {
  test("creates deterministic, checksummed JSONL and CSV release artifacts", async () => {
    const parent = await mkdtemp(join(tmpdir(), "exgen-release-"));
    temporaryDirectories.push(parent);
    const baseOptions = {
      release: {
        id: "release",
        version: "1.0.0",
        title: "Benchmark release",
        description: "Deterministic test release",
        license: "CC-BY-4.0",
        url: "https://example.test/releases/release/1.0.0/",
        creators: [
          {
            name: "Felix Timotheus Johannes Dietrich",
            orcid: "https://orcid.org/0009-0007-5826-2061",
          },
          {
            name: "Sandro Speth",
            orcid: "https://orcid.org/0000-0002-9790-3702",
          },
        ],
        createdAt: "2026-07-30T00:00:00.000Z",
        designation: {
          status: "exploratory" as const,
        },
      },
      benchmark: {
        id: "benchmark",
        planDigest: "f".repeat(64),
        datasetId: "dataset",
        datasetVersion: "1.0.0",
        datasetDigest: "0".repeat(64),
        target: { id: "generic", version: "1", revision: "target" },
      },
      systems: [
        {
          id: "system-a",
          name: "System A",
          version: "1",
          revision: "a",
          factors: {
            approach: { value: "a", control: "declared" as const },
            model: { value: "model-1", control: "observed" as const },
          },
          attestation: { deployment_deviations: [] },
        },
        {
          id: "system-b",
          name: "System B",
          version: "1",
          revision: "b",
          factors: {
            approach: { value: "b", control: "declared" as const },
            model: { value: "model-1", control: "observed" as const },
          },
          attestation: {
            deployment_deviations: [
              { id: "raised-token-budget", description: "Per-job token budget raised to 3M." },
            ],
          },
        },
      ],
      cases: [
        { id: "case-1", title: "Case 1", tags: [], brief: "One", digest: "1".repeat(64) },
        { id: "case-2", title: "Case 2", tags: [], brief: "Two", digest: "2".repeat(64) },
      ],
      metricCards: [
        {
          id: "strict-acceptance",
          version: "1",
          name: "Strict acceptance",
          tier: "confirmatory" as const,
          construct: "End-to-end strict success",
          unit: "proportion",
          value_type: "proportion" as const,
          valid_range: { minimum: 0, maximum: 1 },
          direction: "higher is better",
          population: "planned attempts",
          denominator: "planned attempts",
          status_mapping: "strict success=1; otherwise=0",
          implementation: "evaluation protocol v1",
          evidence: "evaluation responses",
          validation: {
            status: "completed" as const,
            method: "contract tested",
            evidence: [{ uri: "https://example.test/validation/strict" }],
          },
          limitations: "target-specific validity",
        },
        {
          id: "tests.pass_rate",
          version: "1",
          name: "Test pass rate",
          tier: "secondary" as const,
          construct: "Share of tests passed",
          unit: "proportion",
          value_type: "proportion" as const,
          valid_range: { minimum: 0, maximum: 1 },
          direction: "higher is better",
          population: "evaluated candidates",
          denominator: "applicable tests",
          status_mapping: "missing remains missing",
          implementation: "fixture v1",
          evidence: "test report",
          validation: {
            status: "completed" as const,
            method: "fixture",
            evidence: [{ uri: "https://example.test/validation/pass-rate" }],
          },
          limitations: "conditional metric",
        },
      ],
      runManifest: {
        schema_version: "1",
        run_id: "fixture-run",
        run_instance_id: "experiment",
        provenance: { exgen_revision: "fixture" },
      },
      generations,
      evaluations,
      evaluationHistory: [retriedInfrastructureFailure, ...evaluations],
      analysis: {
        method: "case_clustered_paired_bootstrap" as const,
        estimand: "end_to_end_within_budget_strict_success_rate_difference" as const,
        bootstrapSeed: 42,
        bootstrapResamples: 200,
        confidenceLevel: 0.9,
        contrasts: [{ system_a: "system-a", system_b: "system-b" }],
      },
    };
    const firstDirectory = join(parent, "first");
    const secondDirectory = join(parent, "second");
    const first = await exportRelease({ ...baseOptions, outputDirectory: firstDirectory });
    const second = await exportRelease({ ...baseOptions, outputDirectory: secondDirectory });

    expect(first.manifestDigest).toBe(second.manifestDigest);
    const files = await allFiles(firstDirectory);
    expect(files).toContain("data/attempts.jsonl");
    expect(files).toContain("data/attempts.csv");
    expect(files).toContain("metadata/croissant.json");
    expect(files).toContain("metadata/metric-cards.json");
    expect(files).toContain("metadata/run-provenance.json");
    expect(files).toContain("metadata/evidence-index.json");
    expect(files).toContain("data/evaluation-history.jsonl");
    expect(files).toContain("analysis/system-intervals.json");
    expect(files).toContain("ro-crate-metadata.json");
    expect(files).toContain("release-manifest.json");
    expect(files).toContain("analysis/contrasts.json");
    const croissant = JSON.parse(
      await readFile(join(firstDirectory, "metadata/croissant.json"), "utf8"),
    ) as {
      recordSet: Array<{ "@id": string; field: Array<{ name: string }> }>;
    };
    for (const [recordSetId, csvPath] of [
      ["attempts", "data/attempts.csv"],
      ["scores", "data/scores.csv"],
    ] as const) {
      const header = (await readFile(join(firstDirectory, csvPath), "utf8"))
        .split("\n", 1)[0]
        ?.split(",");
      const recordSet = croissant.recordSet.find((candidate) => candidate["@id"] === recordSetId);
      expect(recordSet?.field.map((field) => field.name)).toEqual(header);
    }
    const publicReleaseText = (
      await Promise.all(files.map((path) => readFile(join(firstDirectory, path), "utf8")))
    ).join("\n");
    expect(publicReleaseText).not.toContain("restricted/evaluator-attempt-1.json");
    expect(publicReleaseText).not.toContain("timed out");
    expect(publicReleaseText).not.toContain('"parameters"');
    expect(publicReleaseText).not.toContain('"runtime"');
    const evidenceIndex = JSON.parse(
      await readFile(join(firstDirectory, "metadata/evidence-index.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(evidenceIndex.disclosure_profile).toEqual(PUBLIC_DISCLOSURE_PROFILE);
    expect(evidenceIndex).not.toHaveProperty("policy");
    for (const path of files) {
      expect(await readFile(join(firstDirectory, path), "utf8")).toBe(
        await readFile(join(secondDirectory, path), "utf8"),
      );
    }

    const summary = JSON.parse(
      await readFile(join(firstDirectory, "analysis/summary.json"), "utf8"),
    ) as {
      denominators: {
        planned: number;
        quality_outcomes: number;
        evaluator_strict_successes: number;
        strict_successes: number;
      };
      rates: { end_to_end_strict_success_over_planned: number };
      missingness: { generation_not_started: number };
    };
    expect(summary.denominators).toMatchObject({
      planned: 3,
      quality_outcomes: 2,
      evaluator_strict_successes: 1,
      strict_successes: 1,
    });
    expect(summary.rates.end_to_end_strict_success_over_planned).toBeCloseTo(1 / 3);
    expect(summary.missingness.generation_not_started).toBe(1);
    const manifest = JSON.parse(
      await readFile(join(firstDirectory, "release-manifest.json"), "utf8"),
    ) as {
      counts: { evaluation_history_records: number; evaluation_retries: number };
      release: { designation: { status: string } };
      provenance: { disclosure_profile: { id: string; version: string } };
      analysis: {
        inference_limitations: { cluster_count: number; coverage: string; references: string[] };
      };
    };
    expect(manifest.counts).toMatchObject({
      evaluation_history_records: 3,
      evaluation_retries: 1,
    });
    expect(manifest.provenance.disclosure_profile).toEqual({
      id: PUBLIC_DISCLOSURE_PROFILE.id,
      version: PUBLIC_DISCLOSURE_PROFILE.version,
    });
    expect(manifest.release.designation.status).toBe("exploratory");
    expect(manifest.analysis.inference_limitations.cluster_count).toBe(2);
    expect(manifest.analysis.inference_limitations.coverage).toContain("under-covers");
    expect(manifest.analysis.inference_limitations.references.join(" ")).toContain("Cameron");
    const descriptiveDirectory = join(parent, "descriptive");
    await exportRelease({
      ...baseOptions,
      outputDirectory: descriptiveDirectory,
      analysis: {
        ...baseOptions.analysis,
        method: "case_clustered_bootstrap",
        estimand: "end_to_end_within_budget_strict_success_rate",
        contrasts: [],
      },
    });
    const descriptiveManifest = JSON.parse(
      await readFile(join(descriptiveDirectory, "release-manifest.json"), "utf8"),
    ) as { analysis: { method: string; estimand: string } };
    expect(descriptiveManifest.analysis).toMatchObject({
      method: "case_clustered_bootstrap",
      estimand: "end_to_end_within_budget_strict_success_rate",
    });
    const systemsMetadata = JSON.parse(
      await readFile(join(firstDirectory, "metadata/systems.json"), "utf8"),
    ) as {
      systems: Array<{
        factors: Record<string, unknown>;
        factor_controls: Record<string, string>;
        attestation: { deployment_deviations: Array<{ id: string }> };
      }>;
    };
    expect(systemsMetadata.systems[0]?.factors).toEqual({ approach: "a", model: "model-1" });
    expect(systemsMetadata.systems[0]?.factor_controls).toEqual({
      approach: "declared",
      model: "observed",
    });
    expect(
      systemsMetadata.systems[1]?.attestation.deployment_deviations.map(
        (deviation) => deviation.id,
      ),
    ).toEqual(["raised-token-budget"]);
    await expect(
      exportRelease({
        ...baseOptions,
        outputDirectory: join(parent, "unattested"),
        systems: baseOptions.systems.map(({ attestation: _attestation, ...system }) => ({
          ...system,
        })) as unknown as typeof baseOptions.systems,
      }),
    ).rejects.toThrow("has no deployment attestation");
    const contrasts = JSON.parse(
      await readFile(join(firstDirectory, "analysis/contrasts.json"), "utf8"),
    ) as Array<{ observed_difference: number; complete_attempt_pairs: number }>;
    expect(contrasts).toEqual([
      expect.objectContaining({ observed_difference: 1, complete_attempt_pairs: 1 }),
    ]);
    const contrastSignificance = JSON.parse(
      await readFile(join(firstDirectory, "analysis/contrast-significance.json"), "utf8"),
    ) as Array<{ system_a: string; system_b: string; test: unknown; skip_reason?: string }>;
    // Only one case is a complete pair here, and the wild cluster bootstrap needs at least two.
    expect(contrastSignificance).toEqual([
      {
        system_a: "system-a",
        system_b: "system-b",
        test: null,
        skip_reason: expect.stringContaining("at least two clusters"),
      },
    ]);
    const releaseManifest = JSON.parse(
      await readFile(join(firstDirectory, "release-manifest.json"), "utf8"),
    ) as { analysis: { inference_limitations: { refinement: string } } };
    expect(releaseManifest.analysis.inference_limitations.refinement).toBe("none");

    const wildClusterDirectory = join(parent, "wild-cluster");
    const wildClusterEvaluations: EvaluationResponse[] = [
      evaluationResponse({
        evaluation_id: "1".repeat(64),
        candidate: {
          attempt_id: "wcb-a1",
          case_id: "case-1",
          system_id: "system-a",
          generation_key: "b".repeat(64),
          artifact_digest: "c".repeat(64),
        },
      }),
      evaluationResponse({
        evaluation_id: "2".repeat(64),
        status: "quality_failed",
        candidate: {
          attempt_id: "wcb-b1",
          case_id: "case-1",
          system_id: "system-b",
          generation_key: "6".repeat(64),
          artifact_digest: "7".repeat(64),
        },
      }),
      evaluationResponse({
        evaluation_id: "3".repeat(64),
        status: "quality_failed",
        candidate: {
          attempt_id: "wcb-a2",
          case_id: "case-2",
          system_id: "system-a",
          generation_key: "9".repeat(64),
          artifact_digest: "a".repeat(64),
        },
      }),
      evaluationResponse({
        evaluation_id: "4".repeat(64),
        candidate: {
          attempt_id: "wcb-b2",
          case_id: "case-2",
          system_id: "system-b",
          generation_key: "c".repeat(64),
          artifact_digest: "d".repeat(64),
        },
      }),
    ];
    await exportRelease({
      ...baseOptions,
      outputDirectory: wildClusterDirectory,
      evaluationHistory: wildClusterEvaluations,
      evaluations: wildClusterEvaluations,
      generations: [
        generationObservation({ attempt_id: "wcb-a1", case_id: "case-1", system_id: "system-a" }),
        generationObservation({
          attempt_id: "wcb-b1",
          case_id: "case-1",
          system_id: "system-b",
          generation_key: "6".repeat(64),
          artifact_digest: "7".repeat(64),
          evidence_digest: "8".repeat(64),
        }),
        generationObservation({
          attempt_id: "wcb-a2",
          case_id: "case-2",
          system_id: "system-a",
          generation_key: "9".repeat(64),
          artifact_digest: "a".repeat(64),
          evidence_digest: "b".repeat(64),
        }),
        generationObservation({
          attempt_id: "wcb-b2",
          case_id: "case-2",
          system_id: "system-b",
          generation_key: "c".repeat(64),
          artifact_digest: "d".repeat(64),
          evidence_digest: "e".repeat(64),
        }),
      ],
    });
    const wildClusterSignificance = JSON.parse(
      await readFile(join(wildClusterDirectory, "analysis/contrast-significance.json"), "utf8"),
    ) as Array<{
      system_a: string;
      system_b: string;
      test: { method: string; clusters: number; treated_observations: number } | null;
    }>;
    expect(wildClusterSignificance).toEqual([
      {
        system_a: "system-a",
        system_b: "system-b",
        test: expect.objectContaining({
          method: "wild_cluster_bootstrap_restricted",
          clusters: 2,
          treated_observations: 2,
          control_observations: 2,
        }),
      },
    ]);
    const wildClusterManifest = JSON.parse(
      await readFile(join(wildClusterDirectory, "release-manifest.json"), "utf8"),
    ) as { analysis: { inference_limitations: { refinement: string } } };
    expect(wildClusterManifest.analysis.inference_limitations.refinement).toBe(
      "wild_cluster_bootstrap_restricted",
    );
    await expect(
      exportRelease({
        ...baseOptions,
        outputDirectory: join(parent, "invalid-contrast-family"),
        analysis: {
          ...baseOptions.analysis,
          contrasts: [
            { system_a: "system-a", system_b: "system-b" },
            { system_a: "system-b", system_b: "system-a" },
          ],
        },
      }),
    ).rejects.toThrow("multiplicity method");
    await expect(
      exportRelease({ ...baseOptions, outputDirectory: firstDirectory }),
    ).rejects.toThrow("already exists");
    await expect(
      exportRelease({
        ...baseOptions,
        outputDirectory: join(parent, "submitted-without-registration"),
        release: {
          ...baseOptions.release,
          designation: { status: "submitted" },
        },
      }),
    ).rejects.toThrow("frozen registration");
    await expect(
      exportRelease({
        ...baseOptions,
        outputDirectory: join(parent, "unsafe-string-score"),
        evaluations: [unsafeStringEvaluation, secondEvaluation],
        evaluationHistory: [retriedInfrastructureFailure, unsafeStringEvaluation, secondEvaluation],
      }),
    ).rejects.toThrow("public value contract");

    const terminalGenerations: GenerationObservation[] = generations.map((observation) =>
      observation.state === "planned"
        ? {
            ...observation,
            state: "failed",
            outcome: "failed",
            error_code: "not_started",
            finished_at: "2026-07-30T00:00:01.000Z",
            budget_status: "unverifiable",
          }
        : observation,
    );
    await expect(
      exportRelease({
        ...baseOptions,
        outputDirectory: join(parent, "formal-missing-effective-provenance"),
        release: {
          ...baseOptions.release,
          designation: { status: "submitted" },
        },
        cases: baseOptions.cases.map((datasetCase) => ({
          ...datasetCase,
          origin: {
            kind: "synthetic" as const,
            created_at: "2026-07-30T00:00:00.000Z",
          },
          authors: [{ name: "Fixture Author" }],
          license: "CC-BY-4.0",
          exposure: {
            generator_visible: true as const,
            known_public: false,
            notes: "Synthetic test fixture.",
          },
        })),
        generations: terminalGenerations,
        analysis: {
          ...baseOptions.analysis,
          registration: {
            uri: "https://osf.io/example",
            registered_at: "2026-07-29T00:00:00.000Z",
            revision: "1",
          },
        },
      }),
    ).rejects.toThrow("submitted releases are not enabled");

    // A second evaluator over the same immutable candidates: the tiered design runs an oracle, a
    // static checker and a reference evaluator side by side, and exactly one of them is authoritative.
    const staticEvaluations: EvaluationResponse[] = evaluations.map((response, index) => ({
      ...response,
      evaluation_id: `9${index}`.padEnd(64, "0"),
      evaluator: { ...response.evaluator, id: "java-static" },
      suite: { ...response.suite, id: "java-static-suite" },
      status: "quality_failed" as const,
      strict_success: false,
      failure_category: "quality.threshold_not_met" as const,
      scores: [
        {
          metric_id: "tests.pass_rate",
          metric_version: "1",
          status: "not_applicable" as const,
          evidence: [],
        },
      ],
    }));
    const tieredEvaluations = [...evaluations, ...staticEvaluations];
    const tieredHistory = [retriedInfrastructureFailure, ...tieredEvaluations];
    await expect(
      exportRelease({
        ...baseOptions,
        outputDirectory: join(parent, "tiered-without-declaration"),
        evaluations: tieredEvaluations,
        evaluationHistory: tieredHistory,
      }),
    ).rejects.toThrow("must declare which one is authoritative");

    const tieredDirectory = join(parent, "tiered");
    await exportRelease({
      ...baseOptions,
      outputDirectory: tieredDirectory,
      evaluations: tieredEvaluations,
      evaluationHistory: tieredHistory,
      authoritativeEvaluatorId: "test-evaluator",
    });
    const tieredManifest = JSON.parse(
      await readFile(join(tieredDirectory, "release-manifest.json"), "utf8"),
    ) as {
      authoritative_evaluator_id: string;
      evaluators: Array<{ id: string }>;
      counts: { evaluated: number; evaluation_records: number; strict_successes: number };
    };
    expect(tieredManifest.authoritative_evaluator_id).toBe("test-evaluator");
    expect(tieredManifest.evaluators.map((entry) => entry.id).sort()).toEqual([
      "java-static",
      "test-evaluator",
    ]);
    // The wide attempt table stays on the authoritative evaluator; the extra evaluator adds rows to
    // the normalised index rather than a column block to the release contract.
    expect(tieredManifest.counts.evaluated).toBe(evaluations.length);
    expect(tieredManifest.counts.evaluation_records).toBe(tieredEvaluations.length);
    expect(tieredManifest.counts.strict_successes).toBe(
      (
        JSON.parse(await readFile(join(firstDirectory, "release-manifest.json"), "utf8")) as {
          counts: { strict_successes: number };
        }
      ).counts.strict_successes,
    );
    const tieredFiles = await allFiles(tieredDirectory);
    expect(tieredFiles).toContain("data/evaluation-index.csv");
    expect(tieredFiles).toContain("data/evaluation-index.jsonl");
    const evaluationIndex = (
      await readFile(join(tieredDirectory, "data/evaluation-index.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { evaluator_id: string; authoritative: boolean });
    expect(evaluationIndex).toHaveLength(tieredEvaluations.length);
    expect(evaluationIndex.filter((row) => row.authoritative)).toHaveLength(evaluations.length);
    const tieredSummary = JSON.parse(
      await readFile(join(tieredDirectory, "analysis/summary.json"), "utf8"),
    ) as {
      authoritative_evaluator_id: string;
      evaluators: Array<{ evaluator_id: string; authoritative: boolean }>;
      metrics_conditional_on_strict_success: Array<{
        metric_id: string;
        evaluator_id: string;
        not_applicable: number;
        applicable_denominator: number;
        numeric_mean: number | null;
      }>;
    };
    expect(tieredSummary.evaluators).toHaveLength(2);
    // Every reference-style score is not_applicable here, and the aggregate must say so rather than
    // report a zero mean over a population that has no observations.
    const inapplicable = tieredSummary.metrics_conditional_on_strict_success.find(
      (metric) => metric.evaluator_id === "java-static",
    );
    expect(inapplicable?.not_applicable).toBeGreaterThan(0);
    expect(inapplicable?.applicable_denominator).toBe(0);
    expect(inapplicable?.numeric_mean).toBeNull();

    // Two identities of the same evaluator in one analysis remains a contract violation.
    await expect(
      exportRelease({
        ...baseOptions,
        outputDirectory: join(parent, "mixed-evaluator-versions"),
        evaluations: [
          ...evaluations,
          ...staticEvaluations.map((response) => ({
            ...response,
            evaluator: { ...response.evaluator, id: "test-evaluator", version: "2.0.0" },
            suite: { ...response.suite, id: "suite" },
          })),
        ],
        evaluationHistory: [
          retriedInfrastructureFailure,
          ...evaluations,
          ...staticEvaluations.map((response) => ({
            ...response,
            evaluator: { ...response.evaluator, id: "test-evaluator", version: "2.0.0" },
            suite: { ...response.suite, id: "suite" },
          })),
        ],
        authoritativeEvaluatorId: "test-evaluator",
      }),
    ).rejects.toThrow("cannot mix identities of evaluator");

    const scored = (metricId: string, status: "ok" | "infra_failure"): EvaluationResponse[] =>
      evaluations.map((response) => ({
        ...response,
        scores: [
          status === "ok"
            ? { metric_id: metricId, metric_version: "1", status, value: 1, evidence: [] }
            : { metric_id: metricId, metric_version: "1", status, message: "died", evidence: [] },
        ],
      }));
    await expect(
      exportRelease({
        ...baseOptions,
        outputDirectory: join(parent, "undocumented"),
        evaluations: scored("oracle.satisfied", "ok"),
        evaluationHistory: scored("oracle.satisfied", "ok"),
      }),
    ).rejects.toThrow("missing metric cards (id@version): oracle.satisfied@1");
    // An infra_failure score reports that nothing was measured, so it documents no construct.
    await exportRelease({
      ...baseOptions,
      outputDirectory: join(parent, "sentinel"),
      evaluations: scored("evaluation.runtime", "infra_failure"),
      evaluationHistory: scored("evaluation.runtime", "infra_failure"),
    });
  });
});
