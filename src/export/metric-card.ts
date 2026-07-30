import { z } from "zod";
import { conditional } from "../json-schema.ts";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const metricCardSchema = z
  .object({
    id: identifier,
    version: z.string().min(1),
    name: z.string().min(1),
    tier: z.enum(["confirmatory", "secondary", "exploratory"]),
    construct: z.string().min(1),
    unit: z.string().min(1),
    value_type: z.enum(["boolean", "proportion", "count", "number", "string"]),
    allowed_values: z.array(z.string().min(1)).min(1).optional(),
    valid_range: z
      .object({
        minimum: z.number(),
        maximum: z.number(),
      })
      .strict()
      .refine((range) => range.minimum <= range.maximum, {
        message: "minimum must not exceed maximum",
      })
      .optional(),
    direction: z.string().min(1),
    population: z.string().min(1),
    denominator: z.string().min(1),
    status_mapping: z.string().min(1),
    implementation: z.string().min(1),
    evidence: z.string().min(1),
    validation: z
      .object({
        status: z.enum(["planned", "completed"]),
        method: z.string().min(1),
        evidence: z
          .array(
            z
              .object({
                uri: z.string().url(),
                sha256: z
                  .string()
                  .regex(/^[a-f0-9]{64}$/)
                  .optional(),
              })
              .strict(),
          )
          .default([]),
      })
      .strict(),
    limitations: z.string().min(1),
  })
  .strict()
  .superRefine((metric, context) => {
    if (metric.value_type === "string" && metric.allowed_values === undefined) {
      context.addIssue({
        code: "custom",
        path: ["allowed_values"],
        message: "a public string metric requires a finite allowed-values vocabulary",
      });
    }
    if (metric.value_type !== "string" && metric.allowed_values !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["allowed_values"],
        message: "allowed values apply only to string metrics",
      });
    }
    if (
      metric.allowed_values !== undefined &&
      new Set(metric.allowed_values).size !== metric.allowed_values.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["allowed_values"],
        message: "allowed values must be unique",
      });
    }
  })
  .meta({
    allOf: [
      conditional(
        {
          properties: { value_type: { const: "string" } },
          required: ["value_type"],
        },
        { required: ["allowed_values"] },
        { not: { required: ["allowed_values"] } },
      ),
      {
        properties: {
          allowed_values: { uniqueItems: true },
        },
      },
    ],
  });

export const metricCardsSchema = z
  .object({
    schema_version: z.literal("1"),
    metrics: z.array(metricCardSchema).min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const identities = value.metrics.map((metric) => `${metric.id}\0${metric.version}`);
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: "custom",
        path: ["metrics"],
        message: "metric card (id, version) identities must be unique",
      });
    }
  });

export type MetricCard = z.infer<typeof metricCardSchema>;
