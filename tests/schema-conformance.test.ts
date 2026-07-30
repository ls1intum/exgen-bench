import { describe, expect, test } from "bun:test";
import Ajv2020, { type AnySchema, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import type { ZodType } from "zod";
import { generationResponseSchema, generatorDescriptorSchema } from "../src/contracts.ts";
import { evaluationResponseSchema } from "../src/evaluation/contracts.ts";
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
      "metric-cards",
      "public-attempt",
      "public-catalog",
      "public-release",
    ];
    await Promise.all(schemaNames.map(validator));
  });

  test("preserves generation response conditions", async () => {
    const valid = {
      protocol_version: "1",
      status: "succeeded",
      artifacts: [{ role: "exercise", path: "exercise" }],
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
      missingEffectiveSeed,
    ]);
  });

  test("requires cancellation support for cancel recovery", async () => {
    const valid = {
      protocol_version: "1",
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

  test("preserves public release designation and fixed stage sets", async () => {
    const valid = await Bun.file("site/data/demo-v0.1/release.json").json();
    const mismatchedDesignation = structuredClone(valid);
    mismatchedDesignation.designation.status = "exploratory";
    const duplicateCoverageStage = structuredClone(valid);
    duplicateCoverageStage.execution_coverage[2].id = "started";
    const duplicateDisposition = structuredClone(valid);
    duplicateDisposition.final_dispositions[7].id = "accepted";
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
      duplicateCoverageStage,
      duplicateDisposition,
      exploratoryWithoutManifest,
      ...invalidDownloadPaths,
    ]);
  });
});
