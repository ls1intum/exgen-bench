import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { readResponseTextBounded } from "../../src/core/files.ts";

const generationSchema = z.looseObject({
  data: z.looseObject({
    id: z.string().min(1),
    model: z.string().min(1).nullish(),
    provider_name: z.string().min(1).nullish(),
    total_cost: z.number().nonnegative(),
    is_byok: z.boolean().nullish(),
    upstream_inference_cost: z.number().nonnegative().nullish(),
    native_tokens_prompt: z.number().int().nonnegative().nullish(),
    native_tokens_completion: z.number().int().nonnegative().nullish(),
    native_tokens_cached: z.number().int().nonnegative().nullish(),
    native_tokens_reasoning: z.number().int().nonnegative().nullish(),
    upstream_id: z.string().min(1).nullish(),
  }),
});

type GenerationRecord = z.infer<typeof generationSchema>["data"];

export interface OpenRouterReconciliationConfig {
  apiKey: string;
  baseUrl: string;
  currency: "USD";
  maximumResponseBytes: number;
  requestTimeoutMs: number;
  maximumLookups: number;
  lookupBudgetMs: number;
  indexingTimeoutMs: number;
}

export interface ExpectedProviderUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  providerRequestIds: string[];
}

const MAX_RETRY_DELAY_MS = 15_000;

async function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  try {
    await delay(milliseconds, undefined, { signal });
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  }
}

function retryDelayMs(header: string | null, attempt: number): number {
  const fallback = Math.min(500 * 2 ** attempt, 4_000);
  if (header === null) return fallback;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
  const date = Date.parse(header);
  return Number.isFinite(date)
    ? Math.min(Math.max(0, date - Date.now()), MAX_RETRY_DELAY_MS)
    : fallback;
}

async function generation(
  id: string,
  config: OpenRouterReconciliationConfig,
  deadline: number,
  signal: AbortSignal,
): Promise<GenerationRecord> {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, "")}/generation`);
  url.searchParams.set("id", id);
  // OpenRouter indexes a generation record seconds after the call it bills, and rate-limits reads.
  const indexingDeadline = Math.min(deadline, Date.now() + config.indexingTimeoutMs);
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.requestTimeoutMs)]),
    });
    const body = await readResponseTextBounded(response, config.maximumResponseBytes);
    if (response.ok) {
      const parsed = generationSchema.parse(JSON.parse(body)).data;
      if (parsed.id !== id) {
        throw new Error(`OpenRouter returned generation ${parsed.id} while reconciling ${id}`);
      }
      return parsed;
    }
    if (response.status !== 404 && response.status !== 429) {
      throw new Error(
        `OpenRouter generation reconciliation returned HTTP ${response.status} for generation ${id}`,
      );
    }
    const delay = retryDelayMs(response.headers.get("retry-after"), attempt);
    if (Date.now() + delay >= indexingDeadline) {
      throw new Error(
        `OpenRouter did not serve generation ${id} within the reconciliation budget (last HTTP ${response.status})`,
      );
    }
    await sleep(delay, signal);
  }
}

function requiredTokens(value: number | null | undefined, field: string, id: string): number {
  if (value == null) {
    throw new Error(`OpenRouter generation ${id} does not report ${field}`);
  }
  return value;
}

function billedCost(record: GenerationRecord): number {
  if (record.is_byok !== true) return record.total_cost;
  if (record.upstream_inference_cost == null) {
    throw new Error(
      `OpenRouter generation ${record.id} is billed through your own provider key but reports no upstream_inference_cost`,
    );
  }
  return record.total_cost + record.upstream_inference_cost;
}

export async function reconcileOpenRouterUsage(
  expected: ExpectedProviderUsage,
  config: OpenRouterReconciliationConfig,
  signal: AbortSignal,
) {
  if (expected.providerRequestIds.length !== expected.modelCalls) {
    throw new Error("OpenRouter reconciliation requires one provider request ID per model call");
  }
  if (new Set(expected.providerRequestIds).size !== expected.providerRequestIds.length) {
    throw new Error("OpenRouter reconciliation requires unique provider request IDs");
  }
  if (expected.providerRequestIds.length > config.maximumLookups) {
    throw new Error(
      `OpenRouter reconciliation needs ${expected.providerRequestIds.length} lookups, above max_lookups (${config.maximumLookups})`,
    );
  }
  const deadline = Date.now() + config.lookupBudgetMs;
  const generations: GenerationRecord[] = [];
  for (const id of expected.providerRequestIds) {
    generations.push(await generation(id, config, deadline, signal));
  }
  const inputTokens = generations.reduce(
    (sum, item) => sum + requiredTokens(item.native_tokens_prompt, "native_tokens_prompt", item.id),
    0,
  );
  const outputTokens = generations.reduce(
    (sum, item) =>
      sum + requiredTokens(item.native_tokens_completion, "native_tokens_completion", item.id),
    0,
  );
  const cachedTokensComplete = generations.every((item) => item.native_tokens_cached != null);
  const cachedInputTokens = generations.reduce(
    (sum, item) => sum + (item.native_tokens_cached ?? 0),
    0,
  );
  if (inputTokens !== expected.inputTokens || outputTokens !== expected.outputTokens) {
    throw new Error(
      `OpenRouter token reconciliation disagrees with Artemis: expected ${expected.inputTokens}/${expected.outputTokens}, observed ${inputTokens}/${outputTokens}`,
    );
  }
  if (
    expected.cachedInputTokens !== undefined &&
    (!cachedTokensComplete || cachedInputTokens !== expected.cachedInputTokens)
  ) {
    throw new Error(
      `OpenRouter cached-token reconciliation disagrees with Artemis: expected ${expected.cachedInputTokens}, observed ${cachedTokensComplete ? cachedInputTokens : "unavailable"}`,
    );
  }
  const reasoningTokensComplete = generations.every((item) => item.native_tokens_reasoning != null);
  const reasoningTokens = generations.reduce(
    (sum, item) => sum + (item.native_tokens_reasoning ?? 0),
    0,
  );
  const amount = generations.reduce((sum, item) => sum + billedCost(item), 0);
  return {
    cost: { amount, currency: config.currency },
    ...(reasoningTokensComplete ? { reasoningTokens } : {}),
    evidence: {
      schema_version: "2",
      provider: "openrouter",
      source: "generation_api",
      currency: config.currency,
      reconciled_at: new Date().toISOString(),
      model_calls: generations.length,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      ...(cachedTokensComplete ? { cached_input_tokens: cachedInputTokens } : {}),
      ...(reasoningTokensComplete ? { reasoning_tokens: reasoningTokens } : {}),
      total_cost: amount,
      byok: generations.some((item) => item.is_byok === true),
      generations: generations.map((item) => ({
        id: item.id,
        model: item.model,
        provider: item.provider_name,
        upstream_id: item.upstream_id,
        input_tokens: item.native_tokens_prompt,
        output_tokens: item.native_tokens_completion,
        cached_input_tokens: item.native_tokens_cached,
        reasoning_tokens: item.native_tokens_reasoning,
        is_byok: item.is_byok === true,
        platform_fee: item.total_cost,
        upstream_inference_cost: item.upstream_inference_cost,
        cost: billedCost(item),
      })),
    },
  };
}
