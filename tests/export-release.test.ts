import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvaluationResponse } from "../src/evaluation/contracts.ts";
import type { GenerationObservation } from "../src/evaluation/summary.ts";
import { PUBLIC_DISCLOSURE_PROFILE } from "../src/export/disclosure.ts";
import { exportRelease } from "../src/export/release.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const generations: GenerationObservation[] = [
  {
    attempt_id: "attempt-a",
    case_id: "case-1",
    system_id: "system-a",
    replicate: 1,
    seed: 1,
    state: "completed",
    outcome: "succeeded",
    error_code: null,
    started_at: "2026-07-30T00:00:00.000Z",
    finished_at: "2026-07-30T00:00:01.000Z",
    generation_key: "b".repeat(64),
    artifact_digest: "c".repeat(64),
    evidence_digest: "d".repeat(64),
    budget_status: "compliant",
    budget_violations: [],
    budget_missing: [],
    generation_duration_ms: 1000,
    model_calls: 1,
    tool_calls: 0,
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
    cost_amount: null,
    cost_currency: null,
  },
  {
    attempt_id: "attempt-b",
    case_id: "case-1",
    system_id: "system-b",
    replicate: 1,
    seed: 1,
    state: "completed",
    outcome: "succeeded",
    error_code: null,
    started_at: "2026-07-30T00:00:00.000Z",
    finished_at: "2026-07-30T00:00:01.000Z",
    generation_key: "2".repeat(64),
    artifact_digest: "3".repeat(64),
    evidence_digest: "4".repeat(64),
    budget_status: "compliant",
    budget_violations: [],
    budget_missing: [],
    generation_duration_ms: 1000,
    model_calls: 1,
    tool_calls: 0,
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
    cost_amount: null,
    cost_currency: null,
  },
  {
    attempt_id: "attempt-c",
    case_id: "case-2",
    system_id: "system-a",
    replicate: 1,
    seed: 2,
    state: "planned",
    outcome: null,
    error_code: null,
    started_at: null,
    finished_at: null,
    generation_key: "5".repeat(64),
    artifact_digest: null,
    evidence_digest: null,
    budget_status: null,
    budget_violations: [],
    budget_missing: [],
    generation_duration_ms: null,
    model_calls: null,
    tool_calls: null,
    input_tokens: null,
    output_tokens: null,
    total_tokens: null,
    cost_amount: null,
    cost_currency: null,
  },
];

const evaluations: EvaluationResponse[] = [
  {
    protocol_version: "1",
    evaluation_id: "a".repeat(64),
    candidate: {
      experiment_id: "experiment",
      attempt_id: "attempt-a",
      generation_key: "b".repeat(64),
      case_id: "case-1",
      system_id: "system-a",
      replicate: 1,
      artifact_digest: "c".repeat(64),
    },
    evaluator: {
      id: "evaluator",
      version: "1.0.0",
      revision: "revision",
      target_profile: "generic",
      implementation_digest: "d".repeat(64),
    },
    suite: { id: "suite", version: "1.0.0", digest: "e".repeat(64) },
    status: "succeeded",
    strict_success: true,
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
    started_at: "2026-07-30T00:00:00.000Z",
    finished_at: "2026-07-30T00:00:01.000Z",
    duration_ms: 1000,
  },
  {
    protocol_version: "1",
    evaluation_id: "1".repeat(64),
    candidate: {
      experiment_id: "experiment",
      attempt_id: "attempt-b",
      generation_key: "2".repeat(64),
      case_id: "case-1",
      system_id: "system-b",
      replicate: 1,
      artifact_digest: "3".repeat(64),
    },
    evaluator: {
      id: "evaluator",
      version: "1.0.0",
      revision: "revision",
      target_profile: "generic",
      implementation_digest: "d".repeat(64),
    },
    suite: { id: "suite", version: "1.0.0", digest: "e".repeat(64) },
    status: "quality_failed",
    strict_success: false,
    failure_category: "tests.failed",
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
    started_at: "2026-07-30T00:00:00.000Z",
    finished_at: "2026-07-30T00:00:01.000Z",
    duration_ms: 1000,
  },
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
          factors: { approach: "a", model: "model-1" },
        },
        {
          id: "system-b",
          name: "System B",
          version: "1",
          revision: "b",
          factors: { approach: "b", model: "model-1" },
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
    const contrasts = JSON.parse(
      await readFile(join(firstDirectory, "analysis/contrasts.json"), "utf8"),
    ) as Array<{ observed_difference: number; complete_attempt_pairs: number }>;
    expect(contrasts).toEqual([
      expect.objectContaining({ observed_difference: 1, complete_attempt_pairs: 1 }),
    ]);
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
  });
});
