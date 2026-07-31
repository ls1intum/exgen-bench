import { z } from "zod";
import { metricCardSchema } from "../src/export/metric-card.ts";
import { conditional, when } from "../src/json-schema.ts";

const identifier = z.string().min(1).max(128);
const count = z.number().int().nonnegative();
const positiveCount = z.number().int().positive();
const rate = z.number().min(0).max(1);
const factorValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a six-digit hexadecimal color");
const relativePublicPath = z
  .string()
  .regex(
    /^\.\/(?:(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)(?:\/(?!\.{1,2}(?:\/|$))[A-Za-z0-9._~-]+)*$/,
    "must be a canonical traversal-free relative public path",
  );
const sameRate = (left: number, right: number) => Math.abs(left - right) < 0.000_6;
const releaseStatus = z.enum(["exploratory", "illustrative"]);
const formalReleaseStatus = releaseStatus.exclude(["illustrative"]);

const publicDesignationSchema = z
  .object({
    status: releaseStatus,
  })
  .strict();

export const publicAttemptSchema = z
  .object({
    observation_id: identifier,
    case_id: identifier,
    system_id: identifier,
    replicate: z.number().int().positive(),
    lifecycle: z.enum(["planned", "running", "completed", "failed", "cancelled", "interrupted"]),
    outcome: z.enum([
      "accepted",
      "quality_failed",
      "abstained",
      "generation_failed",
      "budget_exceeded",
      "budget_unverifiable",
      "infrastructure_failed",
      "not_started",
    ]),
    strict_accepted: z.boolean().nullable(),
    evaluator_strict_accepted: z.boolean().nullable().optional(),
    generation_completed: z.boolean(),
    cost_usd: z.number().nonnegative().optional(),
    generation_duration_seconds: z.number().nonnegative().optional(),
  })
  .strict()
  .superRefine((attempt, context) => {
    const issue = (message: string, path: string[]) =>
      context.addIssue({ code: "custom", message, path });
    if (attempt.generation_completed !== (attempt.lifecycle === "completed")) {
      issue("generation_completed must exactly match a completed lifecycle", [
        "generation_completed",
      ]);
    }
    if ((attempt.outcome === "not_started") !== (attempt.lifecycle === "planned")) {
      issue("not_started is only valid for a planned lifecycle", ["outcome"]);
    }
    if (
      [
        "accepted",
        "quality_failed",
        "abstained",
        "generation_failed",
        "budget_exceeded",
        "budget_unverifiable",
      ].includes(attempt.outcome) &&
      !attempt.generation_completed
    ) {
      issue("a final generation outcome requires completed generation", ["outcome"]);
    }
    const expectedStrictAcceptance =
      attempt.outcome === "accepted"
        ? true
        : [
              "quality_failed",
              "abstained",
              "generation_failed",
              "budget_exceeded",
              "budget_unverifiable",
            ].includes(attempt.outcome)
          ? false
          : null;
    if (attempt.strict_accepted !== expectedStrictAcceptance) {
      issue("strict_accepted must agree with the final disposition", ["strict_accepted"]);
    }
  })
  .meta({
    allOf: [
      when("lifecycle", "completed", {
        properties: { generation_completed: { const: true } },
      }),
      conditional(
        {
          not: {
            properties: { lifecycle: { const: "completed" } },
            required: ["lifecycle"],
          },
        },
        {
          properties: { generation_completed: { const: false } },
        },
      ),
      when("lifecycle", "planned", {
        properties: { outcome: { const: "not_started" } },
      }),
      when("outcome", "not_started", {
        properties: { lifecycle: { const: "planned" } },
      }),
      conditional(
        {
          properties: {
            outcome: {
              enum: [
                "accepted",
                "quality_failed",
                "abstained",
                "generation_failed",
                "budget_exceeded",
                "budget_unverifiable",
              ],
            },
          },
          required: ["outcome"],
        },
        {
          properties: {
            lifecycle: { const: "completed" },
            generation_completed: { const: true },
          },
        },
      ),
      when("outcome", "accepted", {
        properties: { strict_accepted: { const: true } },
      }),
      conditional(
        {
          properties: {
            outcome: {
              enum: [
                "quality_failed",
                "abstained",
                "generation_failed",
                "budget_exceeded",
                "budget_unverifiable",
              ],
            },
          },
          required: ["outcome"],
        },
        {
          properties: { strict_accepted: { const: false } },
        },
      ),
      conditional(
        {
          properties: {
            outcome: { enum: ["infrastructure_failed", "not_started"] },
          },
          required: ["outcome"],
        },
        {
          properties: { strict_accepted: { type: "null" } },
        },
      ),
    ],
  });

const publicCaseResultSchema = z
  .object({
    accepted: count,
    denominator: count,
    quality_failed: count,
    abstained: count,
    generation_failed: count.optional(),
    budget_exceeded: count.optional(),
    budget_unverifiable: count.optional(),
    infrastructure_failed: count,
    not_started: count.optional(),
  })
  .strict()
  .superRefine((result, context) => {
    const total =
      result.accepted +
      result.quality_failed +
      result.abstained +
      (result.generation_failed ?? 0) +
      (result.budget_exceeded ?? 0) +
      (result.budget_unverifiable ?? 0) +
      result.infrastructure_failed +
      (result.not_started ?? 0);
    if (total !== result.denominator) {
      context.addIssue({
        code: "custom",
        path: ["denominator"],
        message: "denominator must equal the sum of mutually exclusive final dispositions",
      });
    }
  });

const costMetricSchema = z
  .object({
    estimate: z.number().nonnegative(),
    currency: z.literal("USD"),
    statistic: z.literal("mean per planned attempt"),
    denominator: positiveCount,
    pricing_basis: z.string().min(1),
  })
  .strict();

const latencyMetricSchema = z
  .object({
    estimate: z.number().nonnegative(),
    unit: z.literal("seconds"),
    statistic: z.literal("median among started attempts"),
    denominator: positiveCount,
  })
  .strict();

const decisionMetricsSchema = z.union([
  z
    .object({
      cost: costMetricSchema,
      latency: latencyMetricSchema.optional(),
    })
    .strict(),
  z
    .object({
      cost: costMetricSchema.optional(),
      latency: latencyMetricSchema,
    })
    .strict(),
]);

const publicSystemSchema = z
  .object({
    id: identifier,
    name: z.string().min(1),
    description: z.string().min(1),
    factors: z.record(z.string(), factorValue),
    color: hexColor,
    planned: positiveCount,
    started: count,
    completed: count,
    accepted: count,
    quality_failed: count,
    abstained: count,
    generation_failed: count.optional(),
    budget_exceeded: count.optional(),
    budget_unverifiable: count.optional(),
    infrastructure_failed: count,
    not_started: count.optional(),
    decision_metrics: decisionMetricsSchema.optional(),
    primary: z
      .object({
        estimate: rate,
        numerator: count,
        denominator: count,
        interval_low: rate,
        interval_high: rate,
        interval_method: z.string().min(1),
        planned_sensitivity: rate,
        started_sensitivity: rate.nullable().optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((system, context) => {
    const finalDispositions =
      system.accepted +
      system.quality_failed +
      system.abstained +
      (system.generation_failed ?? 0) +
      (system.budget_exceeded ?? 0) +
      (system.budget_unverifiable ?? 0) +
      system.infrastructure_failed +
      (system.not_started ?? 0);
    if (finalDispositions !== system.planned) {
      context.addIssue({
        code: "custom",
        path: ["planned"],
        message: "planned must equal the sum of mutually exclusive final dispositions",
      });
    }
    if (system.started + (system.not_started ?? 0) !== system.planned) {
      context.addIssue({
        code: "custom",
        path: ["started"],
        message: "started plus not_started must equal planned",
      });
    }
    if (system.completed > system.started) {
      context.addIssue({
        code: "custom",
        path: ["completed"],
        message: "completed cannot exceed started",
      });
    }
    if (
      system.primary.numerator !== system.accepted ||
      system.primary.denominator !== system.planned ||
      !sameRate(system.primary.estimate, system.accepted / system.planned) ||
      !sameRate(system.primary.planned_sensitivity, system.accepted / system.planned)
    ) {
      context.addIssue({
        code: "custom",
        path: ["primary"],
        message: "primary endpoint must be accepted divided by planned",
      });
    }
    if (
      (system.started === 0 && system.primary.started_sensitivity !== null) ||
      (system.started > 0 &&
        !sameRate(
          system.primary.started_sensitivity ?? Number.NaN,
          system.accepted / system.started,
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["primary", "started_sensitivity"],
        message:
          "started sensitivity must be null when no attempt started, otherwise accepted / started",
      });
    }
    if (
      system.primary.interval_low > system.primary.estimate ||
      system.primary.interval_high < system.primary.estimate
    ) {
      context.addIssue({
        code: "custom",
        path: ["primary"],
        message: "the interval must contain the primary estimate",
      });
    }
    if (
      system.decision_metrics?.cost?.denominator !== undefined &&
      system.decision_metrics.cost.denominator !== system.planned
    ) {
      context.addIssue({
        code: "custom",
        path: ["decision_metrics", "cost", "denominator"],
        message: "cost must cover the planned estimand",
      });
    }
    if (
      system.decision_metrics?.latency?.denominator !== undefined &&
      system.decision_metrics.latency.denominator > system.started
    ) {
      context.addIssue({
        code: "custom",
        path: ["decision_metrics", "latency", "denominator"],
        message: "latency cannot cover more than started attempts",
      });
    }
  });

const publicCaseSchema = z
  .object({
    id: identifier,
    title: z.string().min(1),
    brief: z.string(),
    tags: z.array(z.string()),
    systems: z.record(z.string(), publicCaseResultSchema),
  })
  .strict();

export const publicReleaseSchema = z
  .object({
    schema_version: z.literal("1"),
    release_id: identifier,
    release_version: z.string().min(1),
    source_manifest_sha256: digest.nullable(),
    title: z.string().min(1),
    status: releaseStatus,
    designation: publicDesignationSchema,
    published_at: z.string().min(1),
    summary: z.string().min(1),
    notice: z.string().min(1),
    scope: z
      .object({
        target: z.string().min(1),
        dataset: z.string().min(1),
        cases: count,
        systems: count,
        planned_attempts: count,
        budget: z.string().min(1),
      })
      .strict(),
    systems: z.array(publicSystemSchema).min(1),
    primary_contrast: z
      .object({
        system_a: identifier,
        system_b: identifier,
        estimate: z.number().min(-1).max(1),
        interval_low: z.number().min(-1).max(1),
        interval_high: z.number().min(-1).max(1),
        unit: z.string().min(1),
        method: z.string().min(1),
        note: z.string().min(1),
      })
      .strict()
      .nullable(),
    cases: z.array(publicCaseSchema).min(1),
    metrics: z.array(metricCardSchema).min(1),
    limitations: z.array(z.string().min(1)).min(1),
    provenance: z.record(z.string(), z.string()),
    downloads: z.array(
      z
        .object({
          id: identifier,
          label: z.string().min(1),
          description: z.string().min(1),
          path: relativePublicPath,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((release, context) => {
    if (release.designation.status !== release.status) {
      context.addIssue({
        code: "custom",
        path: ["designation", "status"],
        message: "designation status must match the release status",
      });
    }
    if (release.status !== "illustrative" && release.source_manifest_sha256 === null) {
      context.addIssue({
        code: "custom",
        path: ["source_manifest_sha256"],
        message: "a scientific release must identify its formal source manifest",
      });
    }
    if (release.scope.systems !== release.systems.length) {
      context.addIssue({
        code: "custom",
        path: ["scope", "systems"],
        message: "scope.systems must match the system array",
      });
    }
    if (release.scope.cases !== release.cases.length) {
      context.addIssue({
        code: "custom",
        path: ["scope", "cases"],
        message: "scope.cases must match the case array",
      });
    }
    const systemTotals = release.systems.reduce(
      (totals, system) => ({
        planned: totals.planned + system.planned,
        started: totals.started + system.started,
        completed: totals.completed + system.completed,
        accepted: totals.accepted + system.accepted,
        quality_failed: totals.quality_failed + system.quality_failed,
        abstained: totals.abstained + system.abstained,
        generation_failed: totals.generation_failed + (system.generation_failed ?? 0),
        budget_exceeded: totals.budget_exceeded + (system.budget_exceeded ?? 0),
        budget_unverifiable: totals.budget_unverifiable + (system.budget_unverifiable ?? 0),
        infrastructure_failed: totals.infrastructure_failed + system.infrastructure_failed,
        not_started: totals.not_started + (system.not_started ?? 0),
      }),
      {
        planned: 0,
        started: 0,
        completed: 0,
        accepted: 0,
        quality_failed: 0,
        abstained: 0,
        generation_failed: 0,
        budget_exceeded: 0,
        budget_unverifiable: 0,
        infrastructure_failed: 0,
        not_started: 0,
      },
    );
    if (release.scope.planned_attempts !== systemTotals.planned) {
      context.addIssue({
        code: "custom",
        path: ["scope", "planned_attempts"],
        message: "scope.planned_attempts must match summed system plans",
      });
    }
    if (new Set(release.systems.map((system) => system.id)).size !== release.systems.length) {
      context.addIssue({
        code: "custom",
        path: ["systems"],
        message: "system IDs must be unique",
      });
    }
    const colorByApproach = new Map<string, string>();
    for (const [index, system] of release.systems.entries()) {
      const approach = String(system.factors.approach ?? "Unspecified");
      const assignedColor = colorByApproach.get(approach);
      if (assignedColor !== undefined && assignedColor !== system.color) {
        context.addIssue({
          code: "custom",
          path: ["systems", index, "color"],
          message: "systems sharing an approach must share one color",
        });
      } else {
        colorByApproach.set(approach, system.color);
      }
    }
    if (new Set(release.cases.map((caseItem) => caseItem.id)).size !== release.cases.length) {
      context.addIssue({
        code: "custom",
        path: ["cases"],
        message: "case IDs must be unique",
      });
    }
    for (const caseItem of release.cases) {
      for (const system of release.systems) {
        if (caseItem.systems[system.id] === undefined) {
          context.addIssue({
            code: "custom",
            path: ["cases", caseItem.id, "systems"],
            message: `case is missing a result for ${system.id}`,
          });
        }
      }
      const knownSystemIds = new Set(release.systems.map((system) => system.id));
      if (Object.keys(caseItem.systems).some((systemId) => !knownSystemIds.has(systemId))) {
        context.addIssue({
          code: "custom",
          path: ["cases", caseItem.id, "systems"],
          message: "case results may only reference declared systems",
        });
      }
    }
    if (release.primary_contrast !== null) {
      const systemIds = new Set(release.systems.map((system) => system.id));
      if (
        release.primary_contrast.system_a === release.primary_contrast.system_b ||
        !systemIds.has(release.primary_contrast.system_a) ||
        !systemIds.has(release.primary_contrast.system_b) ||
        release.primary_contrast.interval_low > release.primary_contrast.estimate ||
        release.primary_contrast.interval_high < release.primary_contrast.estimate
      ) {
        context.addIssue({
          code: "custom",
          path: ["primary_contrast"],
          message: "primary contrast must compare distinct known systems and contain its estimate",
        });
      }
    }
  })
  .meta({
    allOf: [
      when("status", "exploratory", {
        properties: {
          designation: {
            properties: { status: { const: "exploratory" } },
          },
          source_manifest_sha256: { type: "string" },
        },
      }),
      when("status", "illustrative", {
        properties: {
          designation: {
            properties: { status: { const: "illustrative" } },
          },
        },
      }),
    ],
  });

export const publicCatalogSchema = z
  .object({
    schema_version: z.literal("1"),
    default_release_id: identifier,
    releases: z
      .array(
        z
          .object({
            id: identifier,
            label: z.string().min(1),
            manifest: relativePublicPath,
            status: releaseStatus,
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((catalog, context) => {
    if (!catalog.releases.some((release) => release.id === catalog.default_release_id)) {
      context.addIssue({
        code: "custom",
        path: ["default_release_id"],
        message: "default_release_id must identify a catalog release",
      });
    }
    if (new Set(catalog.releases.map((release) => release.id)).size !== catalog.releases.length) {
      context.addIssue({
        code: "custom",
        path: ["releases"],
        message: "release IDs must be unique",
      });
    }
  });

export type PublicAttempt = z.infer<typeof publicAttemptSchema>;
export type PublicRelease = z.infer<typeof publicReleaseSchema>;
export type FormalReleaseStatus = z.infer<typeof formalReleaseStatus>;

export const formalReleaseDesignationSchema = z
  .object({
    status: formalReleaseStatus,
  })
  .strict();
