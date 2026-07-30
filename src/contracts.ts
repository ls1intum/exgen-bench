import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "use lowercase letters, digits, '.', '_' or '-'");

const jsonScalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const jsonObject = z.record(z.string(), z.unknown());

export const datasetCaseSchema = z
  .object({
    id: identifier,
    title: z.string().min(1),
    brief: z.string().min(1),
    tags: z.array(identifier).default([]),
    origin: z
      .object({
        kind: z.enum(["synthetic", "adapted", "collected"]),
        source_uri: z.string().url().optional(),
        citation: z.string().min(1).optional(),
        created_at: z.string().date(),
        first_public_at: z.string().date().optional(),
      })
      .strict(),
    authors: z
      .array(
        z
          .object({
            name: z.string().min(1),
            orcid: z
              .string()
              .regex(/^https:\/\/orcid\.org\/\d{4}-\d{4}-\d{4}-\d{3}[\dX]$/)
              .optional(),
          })
          .strict(),
      )
      .min(1),
    license: z.string().min(1),
    exposure: z
      .object({
        generator_visible: z.literal(true),
        known_public: z.boolean(),
        notes: z.string().min(1),
      })
      .strict(),
    extensions: jsonObject.default({}),
  })
  .strict();

export const datasetSchema = z
  .object({
    schema_version: z.literal("1"),
    id: identifier,
    version: z.string().min(1),
    title: z.string().min(1),
    description: z.string().min(1),
    license: z.string().min(1),
    cases: z.array(datasetCaseSchema).min(1),
    extensions: jsonObject.default({}),
  })
  .strict();

const commandRuntimeSchema = z
  .object({
    type: z.literal("command"),
    command: z.array(z.string().min(1)).min(1),
    env: z.record(z.string(), z.string().min(1)).default({}),
  })
  .strict();

const containerRuntimeSchema = z
  .object({
    type: z.literal("container"),
    engine: z.enum(["docker", "podman"]).default("docker"),
    image: z
      .string()
      .regex(
        /@sha256:[a-f0-9]{64}$/,
        "formal container runtimes must use an immutable image digest",
      ),
    command: z.array(z.string().min(1)).default([]),
    env: z.record(z.string(), z.string().min(1)).default({}),
    network: z.enum(["none", "provider"]).default("provider"),
    read_only: z.boolean().default(true),
    pids_limit: z.number().int().positive().default(256),
    memory_mb: z.number().int().positive(),
    cpus: z.number().positive(),
    user: z.string().min(1).optional(),
  })
  .strict();

export const systemSchema = z
  .object({
    id: identifier,
    name: z.string().min(1),
    version: z.string().min(1),
    revision: z.string().min(1),
    runtime: z.discriminatedUnion("type", [commandRuntimeSchema, containerRuntimeSchema]),
    factors: z.record(z.string(), jsonScalar).default({}),
    parameters: jsonObject.default({}),
  })
  .strict();

export const generatorDescriptorSchema = z
  .object({
    protocol_version: z.literal("1"),
    kind: z.literal("generator"),
    id: identifier,
    version: z.string().min(1),
    revision: z.string().min(1),
    runtime: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
        revision: z.string().min(1).optional(),
      })
      .strict(),
    capabilities: z
      .object({
        targets: z.array(identifier).min(1),
        seed: z.enum(["unsupported", "best_effort", "deterministic"]),
        failed_artifact_capture: z.enum(["none", "partial", "complete"]),
        cancellation: z.boolean(),
      })
      .strict(),
    parameters_schema: jsonObject.optional(),
  })
  .strict();

export const targetSchema = z
  .object({
    id: identifier,
    adapter: identifier,
    version: z.string().min(1),
    revision: z.string().min(1),
    parameters: jsonObject.default({}),
  })
  .strict();

export const resourceBudgetSchema = z
  .object({
    wall_time_ms: z.number().int().positive(),
    max_model_calls: z.number().int().positive().optional(),
    max_tool_calls: z.number().int().positive().optional(),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    max_total_tokens: z.number().int().positive().optional(),
    max_cost: z
      .object({
        amount: z.number().positive(),
        currency: z.string().length(3),
      })
      .strict()
      .optional(),
  })
  .strict();

export const analysisProtocolSchema = z
  .object({
    method: z.literal("case_clustered_paired_bootstrap").default("case_clustered_paired_bootstrap"),
    estimand: z
      .literal("end_to_end_within_budget_strict_success_rate_difference")
      .default("end_to_end_within_budget_strict_success_rate_difference"),
    bootstrap_seed: z.number().int().min(0).max(0xffffffff),
    bootstrap_resamples: z.number().int().min(1),
    confidence_level: z.number().gt(0).lt(1),
    contrasts: z
      .array(
        z
          .object({
            system_a: identifier,
            system_b: identifier,
          })
          .strict(),
      )
      .max(1, "protocol v1 permits one confirmatory contrast")
      .default([]),
    registration: z
      .object({
        uri: z.string().url(),
        registered_at: z.string().datetime({ offset: true }),
        revision: z.string().min(1),
        amendment_uri: z.string().url().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const benchmarkConfigSchema = z
  .object({
    schema_version: z.literal("1"),
    id: identifier,
    title: z.string().min(1),
    dataset: z.string().min(1),
    target: targetSchema,
    systems: z.array(systemSchema).min(1),
    budget: resourceBudgetSchema,
    trials: z
      .object({
        replicates: z.number().int().positive(),
        base_seed: z.number().int().min(0).max(0xffffffff),
      })
      .strict(),
    analysis: analysisProtocolSchema,
    execution: z
      .object({
        results_dir: z.string().min(1).default(".exgen/runs"),
        concurrency: z.number().int().positive().default(1),
        max_log_bytes: z
          .number()
          .int()
          .positive()
          .default(10 * 1024 * 1024),
      })
      .strict(),
    extensions: jsonObject.default({}),
  })
  .strict()
  .superRefine((benchmark, context) => {
    const systemIds = new Set(benchmark.systems.map((system) => system.id));
    for (const [index, contrast] of benchmark.analysis.contrasts.entries()) {
      if (
        contrast.system_a === contrast.system_b ||
        !systemIds.has(contrast.system_a) ||
        !systemIds.has(contrast.system_b)
      ) {
        context.addIssue({
          code: "custom",
          path: ["analysis", "contrasts", index],
          message: "contrast must reference two distinct configured systems",
        });
      }
    }
  });

export const usageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    reasoning_tokens: z.number().int().nonnegative().optional(),
    cached_input_tokens: z.number().int().nonnegative().optional(),
    total_tokens: z.number().int().nonnegative().optional(),
    model_calls: z.number().int().nonnegative().optional(),
    tool_calls: z.number().int().nonnegative().optional(),
  })
  .strict();

export const generationExecutionSchema = z
  .object({
    requested_seed: z.number().int().min(0).max(0xffffffff),
    seed_status: z.enum(["honored", "not_honored", "unsupported", "unverifiable"]),
    effective_seed: z.number().int().min(0).max(0xffffffff).optional(),
    effective_parameters: jsonObject,
    provider_request_ids: z.array(z.string().min(1)),
    provider_request_ids_complete: z.boolean(),
  })
  .strict()
  .superRefine((execution, context) => {
    if (execution.seed_status === "honored" && execution.effective_seed === undefined) {
      context.addIssue({
        code: "custom",
        path: ["effective_seed"],
        message: "an honored seed requires the effective seed",
      });
    }
  });

export const generationRequestSchema = z
  .object({
    protocol_version: z.literal("1"),
    attempt: z
      .object({
        id: z.string().min(1),
        replicate: z.number().int().positive(),
        seed: z.number().int().min(0).max(0xffffffff),
      })
      .strict(),
    case: z
      .object({
        id: identifier,
        title: z.string().min(1),
        brief: z.string(),
        tags: z.array(identifier),
      })
      .strict(),
    target: targetSchema,
    budget: resourceBudgetSchema,
    parameters: jsonObject,
    output_dir: z.string().min(1),
  })
  .strict();

export const artifactSchema = z
  .object({
    role: identifier,
    path: z.string().min(1),
    media_type: z.string().min(1).optional(),
  })
  .strict();

export const generationResponseSchema = z
  .object({
    protocol_version: z.literal("1"),
    status: z.enum(["succeeded", "failed", "abstained", "infra_failed"]),
    artifacts: z.array(artifactSchema).default([]),
    capture: z
      .object({
        completeness: z.enum(["complete", "partial", "none"]),
        reason: z.string().min(1).optional(),
      })
      .strict(),
    message: z.string().optional(),
    model: z
      .object({
        provider: z.string().min(1),
        id: z.string().min(1),
        version: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    usage: usageSchema.optional(),
    execution: generationExecutionSchema.optional(),
    cost: z
      .object({
        amount: z.number().nonnegative(),
        currency: z.string().length(3),
      })
      .strict()
      .optional(),
    extensions: jsonObject.default({}),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded" && value.artifacts.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["artifacts"],
        message: "a succeeded response must declare at least one artifact",
      });
    }
    if (value.capture.completeness === "none" && value.artifacts.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["capture", "completeness"],
        message: "capture cannot be 'none' when artifacts are declared",
      });
    }
  });

export type BenchmarkConfig = z.infer<typeof benchmarkConfigSchema>;
export type Dataset = z.infer<typeof datasetSchema>;
export type DatasetCase = z.infer<typeof datasetCaseSchema>;
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type GenerationResponse = z.infer<typeof generationResponseSchema>;
export type GeneratorDescriptor = z.infer<typeof generatorDescriptorSchema>;
export type System = z.infer<typeof systemSchema>;
export type Target = z.infer<typeof targetSchema>;
