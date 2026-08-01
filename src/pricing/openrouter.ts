import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Decimal from "decimal.js";
import { z } from "zod";
import type { GenerationResponse } from "../contracts.ts";
import { canonicalJson, sha256 } from "../core/canonical.ts";
import {
  readResponseTextBounded,
  readTextBounded,
  writeJsonAtomic,
  writeTextAtomic,
} from "../core/files.ts";

const decimalString = z.string().regex(/^\d+(?:\.\d+)?$/);
const listedPricingSchema = z
  .object({
    prompt: z.string(),
    completion: z.string(),
    input_cache_read: z.string().optional(),
    request: z.string().optional(),
  })
  .passthrough();
const pricingSchema = z
  .object({
    prompt: decimalString,
    completion: decimalString,
    input_cache_read: decimalString.optional(),
    request: decimalString.optional(),
    discount: z.number().min(0).max(1).optional(),
    overrides: z.array(z.unknown()).optional(),
    internal_reasoning: decimalString.optional(),
    input_cache_write: decimalString.optional(),
    input_cache_write_1h: decimalString.optional(),
  })
  .passthrough()
  .superRefine((pricing, context) => {
    const unsupported = [
      pricing.overrides && pricing.overrides.length > 0 ? "conditional overrides" : undefined,
      pricing.discount !== undefined && pricing.discount !== 0 ? "a non-zero discount" : undefined,
      pricing.internal_reasoning && new Decimal(pricing.internal_reasoning).gt(0)
        ? "separate reasoning charges"
        : undefined,
      pricing.input_cache_write && new Decimal(pricing.input_cache_write).gt(0)
        ? "cache-write charges"
        : undefined,
      pricing.input_cache_write_1h && new Decimal(pricing.input_cache_write_1h).gt(0)
        ? "one-hour cache-write charges"
        : undefined,
    ].filter((value): value is string => value !== undefined);
    if (unsupported.length > 0) {
      context.addIssue({
        code: "custom",
        message: `text-token reference pricing does not support ${unsupported.join(", ")}`,
      });
    }
  });

const catalogSchema = z.object({
  data: z.array(
    z
      .object({
        id: z.string().min(1),
        canonical_slug: z.string().min(1).optional(),
        pricing: listedPricingSchema,
      })
      .passthrough(),
  ),
});

const endpointsSchema = z.object({
  data: z.object({
    endpoints: z.array(
      z
        .object({
          provider_name: z.string().min(1),
          tag: z.string().min(1),
          quantization: z.string().nullable().optional(),
          status: z.number().int(),
          pricing: listedPricingSchema,
        })
        .passthrough(),
    ),
  }),
});

const quoteSchema = z
  .strictObject({
    schema_version: z.literal("1"),
    source: z.literal("openrouter_model_catalog"),
    currency: z.literal("USD"),
    requested_model: z.string().min(1),
    catalog_model: z.string().min(1),
    canonical_slug: z.string().min(1).nullable(),
    retrieved_at: z.iso.datetime({ offset: true }),
    catalog_url: z.url(),
    endpoints_url: z.url(),
    catalog_http_date: z.iso.datetime({ offset: true }).nullable(),
    endpoints_http_date: z.iso.datetime({ offset: true }).nullable(),
    catalog_response_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    endpoints_response_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    catalog_snapshot_path: z.string().regex(/^pricing\/openrouter\/snapshots\/[a-f0-9]{64}\.json$/),
    endpoints_snapshot_path: z
      .string()
      .regex(/^pricing\/openrouter\/snapshots\/[a-f0-9]{64}\.json$/),
    pricing: pricingSchema,
    active_endpoint_count: z.number().int().nonnegative(),
    active_endpoints: z.array(
      z.strictObject({
        provider_name: z.string().min(1),
        tag: z.string().min(1),
        quantization: z.string().nullable(),
        pricing: pricingSchema,
      }),
    ),
  })
  .superRefine((quote, context) => {
    if (quote.active_endpoints.length > quote.active_endpoint_count) {
      context.addIssue({
        code: "custom",
        path: ["active_endpoints"],
        message: "cannot exceed active_endpoint_count",
      });
    }
    for (const [field, path, digest] of [
      ["catalog_snapshot_path", quote.catalog_snapshot_path, quote.catalog_response_sha256],
      ["endpoints_snapshot_path", quote.endpoints_snapshot_path, quote.endpoints_response_sha256],
    ] as const) {
      if (path !== `pricing/openrouter/snapshots/${digest}.json`) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: "must name its response digest",
        });
      }
    }
  });

export type OpenRouterQuote = z.infer<typeof quoteSchema>;

export const referenceCostSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("estimated"),
      amount: z.number().nonnegative(),
      currency: z.literal("USD"),
      source: z.literal("openrouter_model_catalog"),
      model: z.string().min(1),
      model_source: z.enum(["system_reported", "configured"]),
      retrieved_at: z.iso.datetime({ offset: true }),
      quote_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      rates: z.strictObject({
        prompt: decimalString,
        completion: decimalString,
        input_cache_read: decimalString.nullable(),
        request: decimalString.nullable(),
      }),
      assumptions: z.array(z.string().min(1)),
      active_endpoint_count: z.number().int().nonnegative(),
      priced_active_endpoint_count: z.number().int().nonnegative(),
      active_endpoint_amount_range: z
        .strictObject({ minimum: z.number().nonnegative(), maximum: z.number().nonnegative() })
        .nullable(),
    }),
    z.strictObject({
      status: z.literal("unavailable"),
      source: z.literal("openrouter_model_catalog"),
      reason: z.string().min(1),
    }),
  ])
  .superRefine((cost, context) => {
    if (cost.status !== "estimated") return;
    if (cost.priced_active_endpoint_count > cost.active_endpoint_count) {
      context.addIssue({
        code: "custom",
        path: ["priced_active_endpoint_count"],
        message: "cannot exceed active_endpoint_count",
      });
    }
    if (
      cost.active_endpoint_amount_range !== null &&
      (cost.priced_active_endpoint_count !== cost.active_endpoint_count ||
        cost.active_endpoint_amount_range.minimum > cost.active_endpoint_amount_range.maximum)
    ) {
      context.addIssue({
        code: "custom",
        path: ["active_endpoint_amount_range"],
        message: "requires every active endpoint and an ordered range",
      });
    }
  });

export type ReferenceCost = z.infer<typeof referenceCostSchema>;

interface PricingConfig {
  base_url: string;
  timeout_ms: number;
  max_response_bytes: number;
  model_by_system: Record<string, string>;
}

interface HttpPayload {
  text: string;
  date: string | null;
}

function headerDate(value: string | null): string | null {
  if (value === null) return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function estimate(
  pricing: z.infer<typeof pricingSchema>,
  usage: NonNullable<GenerationResponse["usage"]>,
): { amount: number; assumptions: string[] } | undefined {
  if (usage.input_tokens === undefined || usage.output_tokens === undefined) return undefined;
  if (pricing.input_cache_read !== undefined && usage.cached_input_tokens === undefined) {
    return undefined;
  }
  const cached = usage.cached_input_tokens ?? 0;
  if (cached > usage.input_tokens) return undefined;
  const input = new Decimal(usage.input_tokens - cached).times(pricing.prompt);
  const cachedInput = new Decimal(cached).times(pricing.input_cache_read ?? pricing.prompt);
  const output = new Decimal(usage.output_tokens).times(pricing.completion);
  const requests = new Decimal(usage.model_calls ?? 0).times(pricing.request ?? "0");
  const assumptions = ["text token rates only"];
  if (pricing.input_cache_read === undefined) assumptions.push("no separate cache-read rate");
  if (pricing.request !== undefined) assumptions.push("model_calls used as billable requests");
  return { amount: input.plus(cachedInput).plus(output).plus(requests).toNumber(), assumptions };
}

export class OpenRouterReferencePricing {
  private readonly quotes = new Map<string, Promise<OpenRouterQuote>>();
  private catalog?: Promise<{ body: z.infer<typeof catalogSchema>; payload: HttpPayload }>;

  constructor(
    private readonly runDirectory: string,
    private readonly config: PricingConfig,
  ) {}

  async price(
    systemId: string,
    response: GenerationResponse | undefined,
    attemptDirectory: string,
  ): Promise<ReferenceCost> {
    if (!response?.usage) return this.unavailable("generation usage is unavailable");
    const usage = response.usage;
    const configuredModel = this.config.model_by_system[systemId];
    const model = configuredModel ?? response.model?.id;
    if (!model)
      return this.unavailable("no pricing model was configured or reported by the system");
    const modelSource = configuredModel ? "configured" : "system_reported";
    try {
      const quote = await this.quote(model);
      const priced = estimate(quote.pricing, usage);
      if (!priced) {
        return this.unavailable(
          quote.pricing.input_cache_read !== undefined && usage.cached_input_tokens === undefined
            ? "the catalog has a cache-read rate but cached input tokens are unavailable"
            : "input and output token usage is incomplete",
        );
      }
      const endpointAmounts = quote.active_endpoints
        .map((endpoint) => estimate(endpoint.pricing, usage)?.amount)
        .filter((amount): amount is number => amount !== undefined);
      await writeJsonAtomic(join(attemptDirectory, "reference-pricing.json"), quote);
      return {
        status: "estimated",
        amount: priced.amount,
        currency: "USD",
        source: "openrouter_model_catalog",
        model: quote.catalog_model,
        model_source: modelSource,
        retrieved_at: quote.retrieved_at,
        quote_sha256: sha256(canonicalJson(quote)),
        rates: {
          prompt: quote.pricing.prompt,
          completion: quote.pricing.completion,
          input_cache_read: quote.pricing.input_cache_read ?? null,
          request: quote.pricing.request ?? null,
        },
        assumptions: priced.assumptions,
        active_endpoint_count: quote.active_endpoint_count,
        priced_active_endpoint_count: endpointAmounts.length,
        active_endpoint_amount_range:
          endpointAmounts.length === 0 || endpointAmounts.length !== quote.active_endpoint_count
            ? null
            : { minimum: Math.min(...endpointAmounts), maximum: Math.max(...endpointAmounts) },
      };
    } catch (error) {
      return this.unavailable(error instanceof Error ? error.message : String(error));
    }
  }

  private unavailable(reason: string): ReferenceCost {
    return { status: "unavailable", source: "openrouter_model_catalog", reason };
  }

  private quote(model: string): Promise<OpenRouterQuote> {
    const existing = this.quotes.get(model);
    if (existing) return existing;
    const pending = this.loadOrFetchQuote(model);
    this.quotes.set(model, pending);
    return pending;
  }

  private async loadOrFetchQuote(model: string): Promise<OpenRouterQuote> {
    const quotePath = join(
      this.runDirectory,
      "pricing",
      "openrouter",
      "quotes",
      `${sha256(model)}.json`,
    );
    try {
      const quote = quoteSchema.parse(JSON.parse(await readFile(quotePath, "utf8")));
      await Promise.all([
        this.verifySnapshot(quote.catalog_snapshot_path, quote.catalog_response_sha256),
        this.verifySnapshot(quote.endpoints_snapshot_path, quote.endpoints_response_sha256),
      ]);
      return quote;
    } catch (error) {
      if (
        !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    }

    const catalog = await this.loadCatalog();
    const entry = catalog.body.data.find(
      (candidate) => candidate.id === model || candidate.canonical_slug === model,
    );
    if (!entry) throw new Error(`OpenRouter does not list model ${model}`);
    const baseUrl = this.config.base_url.replace(/\/+$/, "");
    const endpointsUrl = `${baseUrl}/models/${entry.id}/endpoints`;
    const endpointsPayload = await this.fetch(endpointsUrl);
    const endpoints = endpointsSchema.parse(JSON.parse(endpointsPayload.text));
    const catalogDigest = sha256(catalog.payload.text);
    const endpointsDigest = sha256(endpointsPayload.text);
    const catalogSnapshotPath = `pricing/openrouter/snapshots/${catalogDigest}.json`;
    const endpointsSnapshotPath = `pricing/openrouter/snapshots/${endpointsDigest}.json`;
    await Promise.all([
      writeTextAtomic(join(this.runDirectory, catalogSnapshotPath), catalog.payload.text),
      writeTextAtomic(join(this.runDirectory, endpointsSnapshotPath), endpointsPayload.text),
    ]);
    const selectedPricing = pricingSchema.parse(entry.pricing);
    const quote = quoteSchema.parse({
      schema_version: "1",
      source: "openrouter_model_catalog",
      currency: "USD",
      requested_model: model,
      catalog_model: entry.id,
      canonical_slug: entry.canonical_slug ?? null,
      retrieved_at: new Date().toISOString(),
      catalog_url: `${baseUrl}/models`,
      endpoints_url: endpointsUrl,
      catalog_http_date: catalog.payload.date,
      endpoints_http_date: endpointsPayload.date,
      catalog_response_sha256: catalogDigest,
      endpoints_response_sha256: endpointsDigest,
      catalog_snapshot_path: catalogSnapshotPath,
      endpoints_snapshot_path: endpointsSnapshotPath,
      pricing: selectedPricing,
      active_endpoint_count: endpoints.data.endpoints.filter((endpoint) => endpoint.status === 0)
        .length,
      active_endpoints: endpoints.data.endpoints
        .filter((endpoint) => endpoint.status === 0)
        .flatMap((endpoint) => {
          const parsed = pricingSchema.safeParse(endpoint.pricing);
          return parsed.success
            ? [
                {
                  provider_name: endpoint.provider_name,
                  tag: endpoint.tag,
                  quantization: endpoint.quantization ?? null,
                  pricing: parsed.data,
                },
              ]
            : [];
        }),
    });
    await writeJsonAtomic(quotePath, quote);
    return quote;
  }

  private loadCatalog(): Promise<{ body: z.infer<typeof catalogSchema>; payload: HttpPayload }> {
    if (this.catalog) return this.catalog;
    this.catalog = (async () => {
      const url = `${this.config.base_url.replace(/\/+$/, "")}/models`;
      const payload = await this.fetch(url);
      return { body: catalogSchema.parse(JSON.parse(payload.text)), payload };
    })();
    return this.catalog;
  }

  private async fetch(url: string): Promise<HttpPayload> {
    const response = await fetch(url, { signal: AbortSignal.timeout(this.config.timeout_ms) });
    if (!response.ok)
      throw new Error(`OpenRouter pricing request failed with HTTP ${response.status}`);
    return {
      text: await readResponseTextBounded(response, this.config.max_response_bytes),
      date: headerDate(response.headers.get("date")),
    };
  }

  private async verifySnapshot(path: string, expectedDigest: string): Promise<void> {
    const contents = await readTextBounded(
      join(this.runDirectory, path),
      this.config.max_response_bytes,
    );
    if (sha256(contents) !== expectedDigest) {
      throw new Error(`OpenRouter pricing snapshot digest mismatch: ${path}`);
    }
  }
}
