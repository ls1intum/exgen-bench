import { describe, expect, test } from "bun:test";
import Ajv2020, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ZodType } from "zod";
import {
  benchmarkConfigSchema,
  datasetSchema,
  generationResponseSchema,
  generatorDescriptorSchema,
} from "../src/contracts.ts";
import {
  evaluationResponseSchema,
  evaluationSuiteSchema,
  evaluatorIdentitySchema,
} from "../src/evaluation/contracts.ts";
import { processEvaluatorConfigSchema } from "../src/evaluation/process-config.ts";
import { metricCardsSchema } from "../src/export/metric-card.ts";
import {
  publicAttemptSchema,
  publicCatalogSchema,
  publicReleaseSchema,
} from "../site/contracts.ts";

const ajv = new Ajv2020({
  allErrors: true,
  strictSchema: true,
  strictTypes: false,
  strictRequired: false,
});
addFormats(ajv);

const validators = new Map<string, ValidateFunction>();

async function validator(name: string) {
  const existing = validators.get(name);
  if (existing) return existing;
  const schema = (await Bun.file(`schemas/protocol/${name}.schema.json`).json()) as AnySchema;
  const compiled = ajv.compile(schema);
  validators.set(name, compiled);
  return compiled;
}

function formattedErrors(errors: ErrorObject[] | null | undefined): string {
  return errors?.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ") ?? "";
}

async function expectParity(
  name: string,
  contract: ZodType,
  valid: unknown,
  invalid: readonly unknown[],
) {
  const validate = await validator(name);
  expect(contract.safeParse(valid).success).toBeTrue();
  expect(validate(valid), formattedErrors(validate.errors)).toBeTrue();

  for (const candidate of invalid) {
    expect(contract.safeParse(candidate).success).toBeFalse();
    expect(validate(candidate)).toBeFalse();
  }
}

describe("published schema conformance", () => {
  test("publishes valid Draft 2020-12 schemas", async () => {
    const schemaNames = [
      "benchmark-config",
      "dataset",
      "generator-descriptor",
      "generation-request",
      "generation-response",
      "evaluator-identity",
      "evaluation-suite",
      "evaluation-request",
      "evaluation-response",
      "process-evaluator-config",
      "metric-cards",
      "public-attempt",
      "public-catalog",
      "public-release",
    ];
    await Promise.all(schemaNames.map(validator));
  });

  test("accepts externally authored documents that omit every defaulted field", async () => {
    const digest = "a".repeat(64);
    const evaluator = {
      id: "evaluator",
      version: "1",
      revision: "revision",
      target_profile: "java",
      implementation_digest: digest,
    };
    const suite = { id: "suite", version: "1", digest };
    const minimal: readonly (readonly [string, ZodType, unknown])[] = [
      [
        "benchmark-config",
        benchmarkConfigSchema,
        {
          schema_version: "1",
          id: "benchmark",
          title: "Benchmark",
          dataset: "./dataset.yaml",
          target: {
            id: "java",
            version: "1",
            revision: "target-revision",
            parameters: { language: "java", build_system: "maven" },
          },
          systems: [
            {
              id: "system",
              name: "System",
              version: "1",
              revision: "system-revision",
              runtime: { type: "command", command: ["generator"] },
              attestation: { deployment_deviations: [] },
            },
          ],
          budget: { wall_time_ms: 60_000 },
          trials: { replicates: 1, base_seed: 0 },
          analysis: { bootstrap_seed: 0, bootstrap_resamples: 1, confidence_level: 0.95 },
          execution: {},
        },
      ],
      [
        "dataset",
        datasetSchema,
        {
          schema_version: "1",
          id: "dataset",
          version: "1",
          title: "Dataset",
          description: "Dataset fixture.",
          license: "MIT",
          cases: [
            {
              id: "case",
              title: "Case",
              brief: "./case.md",
              origin: { kind: "synthetic", created_at: "2026-07-30" },
              authors: [{ name: "Example Author" }],
              license: "MIT",
              exposure: {
                generator_visible: true,
                known_public: false,
                notes: "Private fixture.",
              },
            },
          ],
        },
      ],
      [
        "generator-descriptor",
        generatorDescriptorSchema,
        {
          protocol_version: "2",
          kind: "generator",
          id: "generator",
          version: "1",
          revision: "generator-revision",
          runtime: { name: "bun", version: "1.3.14" },
          capabilities: {
            targets: ["java"],
            seed: "unsupported",
            failed_artifact_capture: "none",
            cancellation: false,
          },
        },
      ],
      [
        "generation-response",
        generationResponseSchema,
        {
          protocol_version: "2",
          status: "abstained",
          capture: { completeness: "none" },
          diagnostics: [
            {
              id: "trace",
              kind: "trace",
              path: "private/trace.json",
              media_type: "application/json",
              sha256: digest,
              size_bytes: 1,
            },
          ],
        },
      ],
      ["evaluator-identity", evaluatorIdentitySchema, evaluator],
      ["evaluation-suite", evaluationSuiteSchema, suite],
      [
        "evaluation-response",
        evaluationResponseSchema,
        {
          protocol_version: "1",
          evaluation_id: digest,
          candidate: {
            experiment_id: "experiment",
            attempt_id: "attempt",
            generation_key: digest,
            case_id: "case",
            system_id: "system",
            replicate: 1,
            artifact_digest: digest,
          },
          evaluator,
          suite,
          status: "succeeded",
          strict_success: true,
          scores: [{ metric_id: "builds", metric_version: "1", status: "ok", value: true }],
          started_at: "2026-07-30T08:00:00Z",
          finished_at: "2026-07-30T08:00:01Z",
          duration_ms: 1_000,
        },
      ],
      [
        "process-evaluator-config",
        processEvaluatorConfigSchema,
        {
          schema_version: "1",
          evaluator,
          suite,
          requested_metrics: ["acceptance"],
          process: { argv: ["evaluator"], cwd: ".", env: {} },
          execution: {
            timeout_ms: 60_000,
            concurrency: 1,
            maximum_input_bytes: 1_048_576,
            maximum_response_bytes: 16_777_216,
            maximum_log_bytes: 1_048_576,
            termination_grace_ms: 2_000,
          },
        },
      ],
      [
        "metric-cards",
        metricCardsSchema,
        {
          schema_version: "1",
          metrics: [
            {
              id: "builds",
              version: "1",
              name: "Builds",
              tier: "secondary",
              construct: "Whether the candidate builds",
              unit: "boolean",
              value_type: "boolean",
              direction: "true is required",
              population: "Completed candidates",
              denominator: "Completed candidates",
              status_mapping: "build success=true; build failure=false",
              implementation: "bundle-integrity evaluator v1",
              evidence: "Evaluator report",
              validation: { status: "planned", method: "Contract checks only" },
              limitations: "Build success does not imply correctness",
            },
          ],
        },
      ],
    ];

    for (const [name, contract, document] of minimal) {
      await expectParity(name, contract, document, []);
    }
  });

  test("preserves generation response conditions", async () => {
    const valid = {
      protocol_version: "2",
      status: "succeeded",
      artifacts: [{ role: "exercise", path: "exercise" }],
      diagnostics: [
        {
          id: "events",
          kind: "event_journal",
          path: "private/events.jsonl",
          media_type: "application/x-ndjson",
          sha256: "a".repeat(64),
          size_bytes: 42,
          record_count: 1,
          visibility: "restricted",
        },
      ],
      capture: { completeness: "complete" },
      execution: {
        requested_seed: 7,
        seed_status: "honored",
        effective_seed: 7,
        effective_parameters: {},
        provider_request_ids: [],
        provider_request_ids_complete: true,
      },
      extensions: {},
    };
    const { effective_seed: _effectiveSeed, ...executionWithoutEffectiveSeed } = valid.execution;
    const missingEffectiveSeed = {
      ...valid,
      execution: executionWithoutEffectiveSeed,
    };

    await expectParity("generation-response", generationResponseSchema, valid, [
      { ...valid, artifacts: [] },
      { ...valid, capture: { completeness: "none" } },
      {
        ...valid,
        diagnostics: [{ ...valid.diagnostics[0], sha256: "not-a-digest" }],
      },
      {
        ...valid,
        diagnostics: [{ ...valid.diagnostics[0], record_count: undefined }],
      },
      missingEffectiveSeed,
    ]);
  });

  test("requires cancellation support for cancel recovery", async () => {
    const valid = {
      protocol_version: "2",
      kind: "generator",
      id: "generator",
      version: "1",
      revision: "generator-revision",
      runtime: { name: "bun", version: "1.3.14" },
      capabilities: {
        targets: ["java"],
        seed: "best_effort",
        failed_artifact_capture: "partial",
        cancellation: true,
        crash_recovery: "cancel",
      },
    };

    await expectParity("generator-descriptor", generatorDescriptorSchema, valid, [
      {
        ...valid,
        capabilities: { ...valid.capabilities, cancellation: false },
      },
    ]);
  });

  test("accepts a factor written either as a scalar or with its control", async () => {
    const valid = {
      schema_version: "1",
      id: "benchmark",
      title: "Benchmark",
      dataset: "./dataset.yaml",
      target: {
        id: "java",
        version: "1",
        revision: "target-revision",
        parameters: { language: "java", case_overrides: { "case-1": { language: "kotlin" } } },
      },
      systems: [
        {
          id: "system",
          name: "System",
          version: "1",
          revision: "system-revision",
          runtime: { type: "command", command: ["generator"] },
          factors: { approach: "single-call", model: { value: "m", control: "requested" } },
          attestation: { deployment_deviations: [] },
        },
      ],
      budget: { wall_time_ms: 60_000, enforcement: { total_tokens: "system" } },
      trials: { replicates: 1, base_seed: 0 },
      analysis: { bootstrap_seed: 0, bootstrap_resamples: 1, confidence_level: 0.95 },
      execution: {},
    };

    await expectParity("benchmark-config", benchmarkConfigSchema, valid, [
      {
        ...valid,
        systems: [{ ...valid.systems[0], factors: { model: { value: "m", control: "guessed" } } }],
      },
      {
        ...valid,
        systems: [{ ...valid.systems[0], attestation: undefined }],
      },
      { ...valid, budget: { wall_time_ms: 60_000, enforcement: { total_tokens: "operator" } } },
      {
        ...valid,
        target: { ...valid.target, parameters: { build_system: "maven" } },
      },
    ]);
  });

  test("preserves dataset provenance and public exposure conditions", async () => {
    const valid = {
      id: "case",
      title: "Case",
      brief: "./case.md",
      tags: ["java"],
      origin: {
        kind: "adapted",
        source_uri: "https://example.com/source",
        citation: "Example source.",
        created_at: "2026-07-30",
        first_public_at: "2026-07-30",
      },
      authors: [{ name: "Example Author" }],
      license: "MIT",
      exposure: {
        generator_visible: true,
        known_public: true,
        notes: "Public fixture.",
      },
      extensions: {},
    };

    const dataset = {
      schema_version: "1",
      id: "dataset",
      version: "1",
      title: "Dataset",
      description: "Dataset fixture.",
      license: "MIT",
      cases: [valid],
      extensions: {},
    };
    const withCase = (datasetCase: unknown) => ({ ...dataset, cases: [datasetCase] });

    await expectParity("dataset", datasetSchema, dataset, [
      withCase({
        ...valid,
        origin: { kind: "adapted", created_at: "2026-07-30", first_public_at: "2026-07-30" },
      }),
      withCase({
        ...valid,
        origin: { kind: "collected", created_at: "2026-07-30", first_public_at: "2026-07-30" },
      }),
      withCase({ ...valid, origin: { ...valid.origin, citation: undefined } }),
      withCase({ ...valid, origin: { ...valid.origin, first_public_at: undefined } }),
      withCase({ ...valid, origin: { ...valid.origin, source_uri: "https://a.com/ x" } }),
      withCase({ ...valid, origin: { ...valid.origin, source_uri: "http://" } }),
      withCase({ ...valid, tags: ["java", "java"] }),
    ]);
  });

  test("accepts the dataset cases the loader accepts", async () => {
    const base = {
      id: "case",
      title: "Case",
      brief: "./case.md",
      tags: ["java"],
      authors: [{ name: "Example Author" }],
      license: "MIT",
      exposure: { generator_visible: true, known_public: false, notes: "Private fixture." },
    };
    const dataset = {
      schema_version: "1",
      id: "dataset",
      version: "1",
      title: "Dataset",
      description: "Dataset fixture.",
      license: "MIT",
      cases: [
        { ...base, origin: { kind: "synthetic", created_at: "2026-07-30" } },
        {
          ...base,
          id: "collected-case",
          extensions: { difficulty: "advanced" },
          exposure: { generator_visible: true, known_public: true, notes: "Public fixture." },
          origin: {
            kind: "collected",
            source_uri: "https://example.com/source",
            citation: "Example source.",
            created_at: "2026-07-30",
            first_public_at: "2026-07-30",
          },
        },
      ],
      extensions: {},
    };

    await expectParity("dataset", datasetSchema, dataset, []);
  });

  test("preserves evaluation status, score, and failure conditions", async () => {
    const digest = "a".repeat(64);
    const valid = {
      protocol_version: "1",
      evaluation_id: digest,
      candidate: {
        experiment_id: "experiment",
        attempt_id: "attempt",
        generation_key: digest,
        case_id: "case",
        system_id: "system",
        replicate: 1,
        artifact_digest: digest,
      },
      evaluator: {
        id: "evaluator",
        version: "1",
        revision: "revision",
        target_profile: "java",
        implementation_digest: digest,
      },
      suite: { id: "suite", version: "1", digest },
      status: "succeeded",
      strict_success: true,
      scores: [
        {
          metric_id: "builds",
          metric_version: "1",
          status: "ok",
          value: true,
          numerator: 1,
          denominator: 1,
          evidence: [],
        },
      ],
      started_at: "2026-07-30T08:00:00Z",
      finished_at: "2026-07-30T08:00:01Z",
      duration_ms: 1_000,
    };
    const score = valid.scores[0];
    if (!score) throw new Error("missing score fixture");
    const { value: _value, denominator: _denominator, ...scoreWithoutEither } = score;
    const scoreWithoutValue = {
      ...valid,
      scores: [{ ...scoreWithoutEither, denominator: score.denominator }],
    };
    const scoreWithoutDenominator = {
      ...valid,
      scores: [{ ...scoreWithoutEither, value: score.value }],
    };

    await expectParity("evaluation-response", evaluationResponseSchema, valid, [
      { ...valid, strict_success: false },
      {
        ...valid,
        status: "quality_failed",
        strict_success: false,
        failure_category: "evaluator.timeout",
      },
      {
        ...valid,
        status: "infra_failed",
        strict_success: null,
        failure_category: "tests.failed",
      },
      scoreWithoutValue,
      scoreWithoutDenominator,
    ]);
  });

  test("preserves process evaluator configuration constraints", async () => {
    const digest = "a".repeat(64);
    const valid = {
      schema_version: "1",
      evaluator: {
        id: "evaluator",
        version: "1",
        revision: "revision",
        target_profile: "java",
        implementation_digest: digest,
      },
      suite: { id: "suite", version: "1", digest },
      requested_metrics: ["acceptance"],
      process: {
        argv: ["evaluator"],
        cwd: ".",
        env: { EVALUATOR_TOKEN: "HOST_EVALUATOR_TOKEN" },
      },
      execution: {
        timeout_ms: 60_000,
        concurrency: 1,
        maximum_input_bytes: 1_048_576,
        maximum_response_bytes: 16_777_216,
        maximum_log_bytes: 1_048_576,
        termination_grace_ms: 2_000,
      },
    };
    await expectParity("process-evaluator-config", processEvaluatorConfigSchema, valid, [
      { ...valid, requested_metrics: [] },
      { ...valid, requested_metrics: ["acceptance", "acceptance"] },
      { ...valid, process: { ...valid.process, argv: [] } },
      { ...valid, process: { ...valid.process, env: { TOKEN: "not a host variable" } } },
      { ...valid, execution: { ...valid.execution, concurrency: 0 } },
      { ...valid, unexpected: true },
    ]);
  });

  test("preserves metric vocabulary conditions", async () => {
    const metric = {
      id: "feedback-category",
      version: "1",
      name: "Feedback category",
      tier: "secondary",
      construct: "Category of evaluator feedback",
      unit: "category",
      value_type: "string",
      allowed_values: ["actionable", "not_actionable"],
      direction: "descriptive",
      population: "Completed candidates",
      denominator: "Completed candidates",
      status_mapping: "Unavailable evaluations are excluded",
      implementation: "Read the evaluator category",
      evidence: "Evaluator report",
      validation: {
        status: "planned",
        method: "Inter-rater agreement",
        evidence: [],
      },
      limitations: "Categories simplify free-form feedback",
    };
    const valid = { schema_version: "1", metrics: [metric] };

    await expectParity("metric-cards", metricCardsSchema, valid, [
      {
        ...valid,
        metrics: [{ ...metric, allowed_values: undefined }],
      },
      {
        ...valid,
        metrics: [{ ...metric, value_type: "number" }],
      },
      {
        ...valid,
        metrics: [{ ...metric, allowed_values: ["actionable", "actionable"] }],
      },
    ]);
  });

  test("preserves public attempt lifecycle and outcome conditions", async () => {
    const valid = {
      observation_id: "attempt-1",
      case_id: "case-1",
      system_id: "system-1",
      replicate: 1,
      lifecycle: "completed",
      outcome: "accepted",
      strict_accepted: true,
      generation_completed: true,
    };

    await expectParity("public-attempt", publicAttemptSchema, valid, [
      { ...valid, generation_completed: false },
      { ...valid, lifecycle: "planned" },
      { ...valid, strict_accepted: false },
      {
        ...valid,
        lifecycle: "failed",
        outcome: "infrastructure_failed",
        strict_accepted: true,
        generation_completed: false,
      },
    ]);
  });

  test("preserves canonical public paths", async () => {
    const valid = await Bun.file("site/data/catalog.json").json();
    const invalid = ["../../x", "/x", "./../x", "./x%2fy", "./x\\y", "./x?query", "./x#part"].map(
      (manifest) => {
        const catalog = structuredClone(valid);
        catalog.releases[0].manifest = manifest;
        return catalog;
      },
    );

    await expectParity("public-catalog", publicCatalogSchema, valid, invalid);
  });

  test("preserves public release designation and download paths", async () => {
    const valid = await Bun.file("site/data/demo-v0.1/release.json").json();
    const mismatchedDesignation = structuredClone(valid);
    mismatchedDesignation.designation.status = "exploratory";
    const exploratoryWithoutManifest = structuredClone(valid);
    exploratoryWithoutManifest.status = "exploratory";
    exploratoryWithoutManifest.designation.status = "exploratory";
    const invalidDownloadPaths = [
      "../../x",
      "/x",
      "./../x",
      "./x%2fy",
      "./x\\y",
      "./x?query",
      "./x#part",
    ].map((path) => {
      const release = structuredClone(valid);
      release.downloads[0].path = path;
      return release;
    });

    await expectParity("public-release", publicReleaseSchema, valid, [
      mismatchedDesignation,
      exploratoryWithoutManifest,
      ...invalidDownloadPaths,
    ]);
  });
});
