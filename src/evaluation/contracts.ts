import { z } from "zod";
import { when } from "../json-schema.ts";

export const EVALUATION_PROTOCOL_VERSION = "1" as const;

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const evaluatorIdentitySchema = z
  .object({
    id: identifier,
    version: z.string().min(1),
    revision: z.string().min(1),
    target_profile: identifier,
    implementation_digest: digest,
    configuration_digest: digest.optional(),
    image_digest: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

export const evaluationSuiteSchema = z
  .object({
    id: identifier,
    version: z.string().min(1),
    digest,
  })
  .strict();

export const evaluationCandidateSchema = z
  .object({
    experiment_id: z.string().min(1),
    attempt_id: z.string().min(1),
    generation_key: digest,
    case_id: identifier,
    system_id: identifier,
    replicate: z.number().int().positive(),
    artifact_digest: digest,
    bundle_path: z.string().min(1),
  })
  .strict();

export const evaluationRequestSchema = z
  .object({
    protocol_version: z.literal(EVALUATION_PROTOCOL_VERSION),
    evaluation_id: digest,
    candidate: evaluationCandidateSchema,
    evaluator: evaluatorIdentitySchema,
    suite: evaluationSuiteSchema,
    requested_metrics: z.array(identifier),
    timeout_ms: z.number().int().positive().optional(),
  })
  .strict();

export const scoreStatusSchema = z.enum([
  "ok",
  "not_applicable",
  "quality_failure",
  "infra_failure",
]);

export const evaluationScoreSchema = z
  .object({
    metric_id: identifier,
    metric_version: z.string().min(1),
    status: scoreStatusSchema,
    value: z.union([z.number(), z.boolean(), z.string()]).optional(),
    numerator: z.number().finite().optional(),
    denominator: z.number().finite().positive().optional(),
    message: z.string().min(1).optional(),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict()
  .superRefine((score, context) => {
    if (score.status === "ok" && score.value === undefined) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "an available score must contain a value",
      });
    }
    if (score.numerator !== undefined && score.denominator === undefined) {
      context.addIssue({
        code: "custom",
        path: ["denominator"],
        message: "a numerator requires a denominator",
      });
    }
  })
  .meta({
    allOf: [
      when("status", "ok", { required: ["value"] }),
      { dependentRequired: { numerator: ["denominator"] } },
    ],
  });

export const evaluationFailureCategorySchema = z.enum([
  "candidate.invalid",
  "candidate.incomplete",
  "tests.failed",
  "build.failed",
  "quality.threshold_not_met",
  "evaluator.timeout",
  "evaluator.crashed",
  "evaluator.protocol_error",
  "infrastructure.unavailable",
  "other",
]);

export const evaluationResponseSchema = z
  .object({
    protocol_version: z.literal(EVALUATION_PROTOCOL_VERSION),
    evaluation_id: digest,
    candidate: evaluationCandidateSchema.omit({ bundle_path: true }),
    evaluator: evaluatorIdentitySchema,
    suite: evaluationSuiteSchema,
    status: z.enum(["succeeded", "quality_failed", "infra_failed"]),
    strict_success: z.boolean().nullable(),
    failure_category: evaluationFailureCategorySchema.optional(),
    scores: z.array(evaluationScoreSchema),
    started_at: z.string().datetime({ offset: true }),
    finished_at: z.string().datetime({ offset: true }),
    duration_ms: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((response, context) => {
    const metricIds = response.scores.map((score) => `${score.metric_id}\0${score.metric_version}`);
    if (new Set(metricIds).size !== metricIds.length) {
      context.addIssue({
        code: "custom",
        path: ["scores"],
        message: "metric ID and version pairs must be unique within an evaluation",
      });
    }
    if (response.status === "succeeded" && response.strict_success !== true) {
      context.addIssue({
        code: "custom",
        path: ["strict_success"],
        message: "a succeeded evaluation must be a strict success",
      });
    }
    if (response.status === "quality_failed" && response.strict_success !== false) {
      context.addIssue({
        code: "custom",
        path: ["strict_success"],
        message: "a quality failure must be a strict failure",
      });
    }
    if (response.status === "infra_failed" && response.strict_success !== null) {
      context.addIssue({
        code: "custom",
        path: ["strict_success"],
        message: "infrastructure failures have no quality outcome",
      });
    }
    if (response.status === "succeeded" && response.failure_category !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["failure_category"],
        message: "successful evaluations cannot have a failure category",
      });
    }
    if (response.status !== "succeeded" && response.failure_category === undefined) {
      context.addIssue({
        code: "custom",
        path: ["failure_category"],
        message: "failed evaluations require a failure category",
      });
    }
    if (
      response.status === "infra_failed" &&
      response.failure_category !== undefined &&
      ![
        "evaluator.timeout",
        "evaluator.crashed",
        "evaluator.protocol_error",
        "infrastructure.unavailable",
        "other",
      ].includes(response.failure_category)
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure_category"],
        message: "an infrastructure failure requires an infrastructure failure category",
      });
    }
    if (
      response.status === "quality_failed" &&
      response.failure_category !== undefined &&
      [
        "evaluator.timeout",
        "evaluator.crashed",
        "evaluator.protocol_error",
        "infrastructure.unavailable",
      ].includes(response.failure_category)
    ) {
      context.addIssue({
        code: "custom",
        path: ["failure_category"],
        message: "a quality failure cannot use an infrastructure failure category",
      });
    }
  })
  .meta({
    allOf: [
      when("status", "succeeded", {
        properties: { strict_success: { const: true } },
        not: { required: ["failure_category"] },
      }),
      when("status", "quality_failed", {
        properties: {
          strict_success: { const: false },
          failure_category: {
            not: {
              enum: [
                "evaluator.timeout",
                "evaluator.crashed",
                "evaluator.protocol_error",
                "infrastructure.unavailable",
              ],
            },
          },
        },
        required: ["failure_category"],
      }),
      when("status", "infra_failed", {
        properties: {
          strict_success: { type: "null" },
          failure_category: {
            enum: [
              "evaluator.timeout",
              "evaluator.crashed",
              "evaluator.protocol_error",
              "infrastructure.unavailable",
              "other",
            ],
          },
        },
        required: ["failure_category"],
      }),
    ],
  });

export type EvaluationCandidate = z.infer<typeof evaluationCandidateSchema>;
export type EvaluationRequest = z.infer<typeof evaluationRequestSchema>;
export type EvaluationResponse = z.infer<typeof evaluationResponseSchema>;
export type EvaluationScore = z.infer<typeof evaluationScoreSchema>;
export type EvaluationSuite = z.infer<typeof evaluationSuiteSchema>;
export type EvaluatorIdentity = z.infer<typeof evaluatorIdentitySchema>;
