import { z } from "zod";
import { conditional, when } from "./json-schema.ts";

export const GENERATION_PROTOCOL_VERSION = "2";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "use lowercase letters, digits, '.', '_' or '-'");

const jsonObject = z.record(z.string(), z.unknown());

export const httpUrl = z
  .string()
  .regex(/^https?:\/\/[^\s]+$/, "use an absolute http(s) URL without whitespace")
  .url();

export const rfc3339Timestamp = z
  .string()
  .datetime({ offset: true })
  .regex(/T\d{2}:\d{2}:\d{2}/, "use an RFC 3339 timestamp with seconds")
  .meta({ format: "date-time" });

export const datasetCaseSchema = z
  .object({
    id: identifier,
    title: z.string().min(1),
    brief: z.string().min(1),
    tags: z.array(identifier).default([]).meta({ uniqueItems: true }),
    origin: z
      .object({
        kind: z.enum(["synthetic", "adapted", "collected"]),
        source_uri: httpUrl.optional(),
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
    extensions: jsonObject.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.origin.kind !== "synthetic") {
      if (value.origin.source_uri === undefined) {
        context.addIssue({
          code: "custom",
          path: ["origin", "source_uri"],
          message: "adapted and collected cases require a source URI",
        });
      }
      if (value.origin.citation === undefined) {
        context.addIssue({
          code: "custom",
          path: ["origin", "citation"],
          message: "adapted and collected cases require a citation",
        });
      }
    }
    if (value.exposure.known_public && value.origin.first_public_at === undefined) {
      context.addIssue({
        code: "custom",
        path: ["origin", "first_public_at"],
        message: "known public cases require a first-public date",
      });
    }
    if (new Set(value.tags).size !== value.tags.length) {
      context.addIssue({
        code: "custom",
        path: ["tags"],
        message: "case tags must be unique",
      });
    }
  })
  .meta({
    allOf: [
      conditional(
        {
          properties: {
            origin: {
              properties: { kind: { enum: ["adapted", "collected"] } },
              required: ["kind"],
            },
          },
          required: ["origin"],
        },
        {
          properties: {
            origin: { required: ["source_uri", "citation"] },
          },
        },
      ),
      conditional(
        {
          properties: {
            exposure: {
              properties: { known_public: { const: true } },
              required: ["known_public"],
            },
          },
          required: ["exposure"],
        },
        {
          properties: {
            origin: { required: ["first_public_at"] },
          },
        },
      ),
    ],
  });

export const datasetSchema = z
  .object({
    schema_version: z.literal("2"),
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
    network: z.enum(["none", "bridge"]).default("none"),
    read_only: z.literal(true).default(true),
    pids_limit: z.number().int().positive().default(256),
    memory_mb: z.number().int().positive(),
    cpus: z.number().positive(),
    user: z.string().regex(/^[1-9]\d*:[1-9]\d*$/, "use an explicit non-root numeric UID:GID"),
  })
  .strict();

export const factorScalar = z.union([z.string(), z.number(), z.boolean()]);

export const FACTOR_CONTROLS = ["requested", "observed", "declared"] as const;

/**
 * A factor name is a bare snake_case token, never namespaced: the same name has to be written by a
 * configuration, sent on a request, declared in a capability and echoed by a response, and a
 * separator would let those four spellings drift apart.
 */
export const factorName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "use a bare lowercase snake_case factor name");

export const factorSchema = z.union([
  z
    .strictObject({
      value: factorScalar,
      control: z.enum(FACTOR_CONTROLS),
    })
    .meta({ id: "DeclaredFactor" }),
  factorScalar.transform((value) => ({ value, control: "declared" as const })),
]);

export const BUDGET_DIMENSIONS = [
  "wall_time_ms",
  "model_calls",
  "tool_calls",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cost",
] as const;

export const budgetDimensionSchema = z.enum(BUDGET_DIMENSIONS);

const deploymentDeviationSchema = z
  .strictObject({
    id: identifier,
    description: z.string().min(1),
    evidence_uri: httpUrl.optional(),
  })
  .meta({ id: "DeploymentDeviation" });

export const systemSchema = z
  .object({
    id: identifier,
    name: z.string().min(1),
    version: z.string().min(1),
    revision: z.string().min(1),
    runtime: z.discriminatedUnion("type", [commandRuntimeSchema, containerRuntimeSchema]),
    factors: z.record(factorName, factorSchema).default({}),
    parameters: jsonObject.default({}),
    attestation: z.strictObject({
      deployment_deviations: z.array(deploymentDeviationSchema),
    }),
  })
  .strict();

export type FactorScalar = z.infer<typeof factorScalar>;
export type DeclaredFactor = { value: FactorScalar; control: (typeof FACTOR_CONTROLS)[number] };

interface FactorBearing {
  factors: Record<string, DeclaredFactor>;
}

export function armVaryingFactorNames(systems: FactorBearing[]): string[] {
  const names = [...new Set(systems.flatMap((system) => Object.keys(system.factors)))].sort();
  return names.filter(
    (name) =>
      new Set(systems.map((system) => JSON.stringify(system.factors[name]?.value ?? null))).size >
      1,
  );
}

export function distinguishingFactorNames(systems: FactorBearing[]): string[] {
  return armVaryingFactorNames(systems).filter((name) =>
    systems.every((system) => (system.factors[name]?.control ?? "declared") !== "declared"),
  );
}

const generatorCapabilitiesSchema = z
  .object({
    targets: z.array(identifier).min(1),
    seed: z.enum(["unsupported", "best_effort", "deterministic"]),
    failed_artifact_capture: z.enum(["none", "partial", "complete"]),
    cancellation: z.boolean(),
    crash_recovery: z.enum(["none", "cancel"]).optional(),
    budget_dimensions: z.array(budgetDimensionSchema).optional().meta({ uniqueItems: true }),
    controls: z.array(factorName).optional().meta({ uniqueItems: true }),
    observes: z.array(factorName).optional().meta({ uniqueItems: true }),
  })
  .strict()
  .superRefine((capabilities, context) => {
    if (capabilities.crash_recovery === "cancel" && !capabilities.cancellation) {
      context.addIssue({
        code: "custom",
        path: ["cancellation"],
        message: "cancel crash recovery requires cancellation support",
      });
    }
  })
  .meta({
    allOf: [
      when("crash_recovery", "cancel", {
        properties: { cancellation: { const: true } },
      }),
    ],
  });

export const generatorDescriptorSchema = z
  .object({
    protocol_version: z.literal(GENERATION_PROTOCOL_VERSION),
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
    capabilities: generatorCapabilitiesSchema,
    parameters_schema: jsonObject.optional(),
  })
  .strict();

/**
 * Open beyond `language` and `build_system`: the artifact vocabulary belongs to the target, and an
 * adapter validates the whole object against its own schema. Only what the plan folds is typed here.
 */
export const resolvedTargetParametersSchema = z
  .looseObject({
    language: identifier,
    build_system: identifier.optional(),
  })
  .meta({ id: "TargetProfile" });

export const targetParametersSchema = resolvedTargetParametersSchema
  .extend({
    case_overrides: z
      .record(
        identifier,
        z
          .looseObject({
            language: identifier.optional(),
            build_system: identifier.optional(),
          })
          .refine(
            (override) => Object.keys(override).length > 0,
            "a case override must change at least one target parameter",
          ),
      )
      .default({}),
  })
  .meta({ id: "TargetParameters" });

export const targetSchema = z
  .object({
    id: identifier,
    version: z.string().min(1),
    revision: z.string().min(1),
    parameters: targetParametersSchema,
  })
  .strict();

export const resolvedTargetSchema = z
  .object({
    id: identifier,
    version: z.string().min(1),
    revision: z.string().min(1),
    parameters: resolvedTargetParametersSchema,
  })
  .strict();

const costLimitSchema = z
  .strictObject({
    amount: z.number().nonnegative(),
    currency: z.string().length(3),
  })
  .meta({ id: "CostLimit" });

export const resourceBudgetSchema = z
  .object({
    wall_time_ms: z.number().int().positive(),
    max_model_calls: z.number().int().positive().optional(),
    max_tool_calls: z.number().int().positive().optional(),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    max_total_tokens: z.number().int().positive().optional(),
    max_cost: costLimitSchema.optional(),
    enforcement: z.partialRecord(budgetDimensionSchema, z.enum(["harness", "system"])).default({}),
  })
  .strict();

export const LIMIT_SOURCES = ["system_reported", "system_configured"] as const;

export const limitSourceSchema = z.enum(LIMIT_SOURCES);

/**
 * A bare number is an unsourced limit. It is recorded, but only `system_reported` can support the
 * `non_binding` verdict, which says the system's own guard bound before the declared one did.
 */
function sourcedLimit(value: z.ZodNumber) {
  return z.union([z.strictObject({ value, source: limitSourceSchema }), value]);
}

export const effectiveLimitsSchema = z
  .strictObject({
    wall_time_ms: sourcedLimit(z.number().positive()).optional(),
    model_calls: sourcedLimit(z.number().int().positive()).optional(),
    tool_calls: sourcedLimit(z.number().int().positive()).optional(),
    input_tokens: sourcedLimit(z.number().int().positive()).optional(),
    output_tokens: sourcedLimit(z.number().int().positive()).optional(),
    total_tokens: sourcedLimit(z.number().int().positive()).optional(),
    cost: z
      .union([costLimitSchema.extend({ source: limitSourceSchema }), costLimitSchema])
      .optional(),
  })
  .meta({ id: "EffectiveLimits" });

export const analysisProtocolSchema = z
  .object({
    method: z
      .enum(["case_clustered_bootstrap", "case_clustered_paired_bootstrap"])
      .default("case_clustered_paired_bootstrap"),
    estimand: z
      .enum([
        "end_to_end_within_budget_strict_success_rate",
        "end_to_end_within_budget_strict_success_rate_difference",
      ])
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
    design: z
      .strictObject({
        smallest_meaningful_effect: z.number().gt(0).lt(1),
        power: z.number().gt(0).lt(1).default(0.8),
        assumed_success_rate: z.number().gt(0).lt(1).default(0.5),
        assumed_arm_correlation: z.number().min(0).lt(1).default(0.5),
        assumed_intra_case_correlation: z.number().min(0).lt(1).default(0.5),
      })
      .optional(),
    registration: z
      .object({
        uri: httpUrl,
        registered_at: rfc3339Timestamp,
        revision: z.string().min(1),
        amendment_uri: httpUrl.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export const benchmarkConfigSchema = z
  .object({
    schema_version: z.literal("2"),
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
    reference_pricing: z
      .object({
        source: z.literal("openrouter"),
        base_url: httpUrl.default("https://openrouter.ai/api/v1"),
        timeout_ms: z.number().int().positive().default(10_000),
        max_response_bytes: z
          .number()
          .int()
          .positive()
          .default(8 * 1024 * 1024),
        model_by_system: z.record(identifier, z.string().min(1)).default({}),
      })
      .strict()
      .optional(),
    extensions: jsonObject.default({}),
  })
  .strict()
  .superRefine((benchmark, context) => {
    for (const name of armVaryingFactorNames(benchmark.systems)) {
      if (Object.hasOwn(benchmark.target.parameters, name)) {
        context.addIssue({
          code: "custom",
          path: ["target", "parameters", name],
          message: `${name} is a fixed target parameter and cannot also vary across arms`,
        });
      }
    }
    if (benchmark.systems.length > 1 && distinguishingFactorNames(benchmark.systems).length === 0) {
      context.addIssue({
        code: "custom",
        path: ["systems"],
        message:
          "a multi-arm benchmark needs a requested or observed factor whose value differs across arms",
      });
    }
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
    effective_limits: effectiveLimitsSchema.optional(),
    observed_factors: z.record(factorName, factorScalar).optional(),
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
    if (
      execution.seed_status === "honored" &&
      execution.effective_seed !== undefined &&
      execution.effective_seed !== execution.requested_seed
    ) {
      context.addIssue({
        code: "custom",
        path: ["effective_seed"],
        message: "an honored effective seed must equal the requested seed",
      });
    }
  })
  .meta({
    allOf: [
      when("seed_status", "honored", {
        required: ["effective_seed"],
      }),
    ],
  });

export const generationRequestSchema = z
  .object({
    protocol_version: z.literal(GENERATION_PROTOCOL_VERSION),
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
    target: resolvedTargetSchema,
    budget: resourceBudgetSchema,
    factors: z.record(factorName, factorScalar),
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

export const diagnosticSchema = z
  .object({
    id: identifier,
    kind: z.enum(["event_journal", "checkpoint", "trace", "provenance", "other"]),
    path: z.string().min(1),
    media_type: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(64 * 1024 * 1024),
    record_count: z.number().int().nonnegative().optional(),
    visibility: z.enum(["public", "restricted"]).default("restricted"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind === "event_journal") {
      if (value.media_type !== "application/x-ndjson") {
        context.addIssue({
          code: "custom",
          path: ["media_type"],
          message: "event journals must use application/x-ndjson",
        });
      }
      if (value.record_count === undefined) {
        context.addIssue({
          code: "custom",
          path: ["record_count"],
          message: "event journals require a record count",
        });
      }
    }
  })
  .meta({
    allOf: [
      when("kind", "event_journal", {
        required: ["record_count"],
        properties: {
          media_type: { const: "application/x-ndjson" },
        },
      }),
    ],
  });

export const generationResponseSchema = z
  .object({
    protocol_version: z.literal(GENERATION_PROTOCOL_VERSION),
    status: z.enum(["succeeded", "failed", "abstained", "infra_failed"]),
    artifacts: z.array(artifactSchema).default([]),
    diagnostics: z.array(diagnosticSchema).max(128).default([]),
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
    const diagnosticIds = value.diagnostics.map((diagnostic) => diagnostic.id);
    if (new Set(diagnosticIds).size !== diagnosticIds.length) {
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "diagnostic IDs must be unique",
      });
    }
    const diagnosticPaths = value.diagnostics.map((diagnostic) => diagnostic.path);
    if (new Set(diagnosticPaths).size !== diagnosticPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["diagnostics"],
        message: "diagnostic paths must be unique",
      });
    }
  })
  .meta({
    allOf: [
      when("status", "succeeded", {
        required: ["artifacts"],
        properties: { artifacts: { minItems: 1 } },
      }),
      conditional(
        {
          properties: {
            capture: {
              properties: { completeness: { const: "none" } },
              required: ["completeness"],
            },
          },
          required: ["capture"],
        },
        {
          properties: { artifacts: { maxItems: 0 } },
        },
      ),
    ],
  });

export type BenchmarkConfig = z.infer<typeof benchmarkConfigSchema>;
export type BudgetDimension = (typeof BUDGET_DIMENSIONS)[number];
export type EffectiveLimits = z.infer<typeof effectiveLimitsSchema>;
export type LimitSource = (typeof LIMIT_SOURCES)[number];
export type ResolvedTarget = z.infer<typeof resolvedTargetSchema>;
export type ResolvedTargetParameters = z.infer<typeof resolvedTargetParametersSchema>;
export type Dataset = z.infer<typeof datasetSchema>;
export type DatasetCase = z.infer<typeof datasetCaseSchema>;
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type GenerationResponse = z.infer<typeof generationResponseSchema>;
export type GeneratorDescriptor = z.infer<typeof generatorDescriptorSchema>;
export type System = z.infer<typeof systemSchema>;
export type Target = z.infer<typeof targetSchema>;
