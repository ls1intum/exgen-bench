import { afterEach, describe, expect, test } from "bun:test";
import {
  type OpenRouterReconciliationConfig,
  reconcileOpenRouterUsage,
} from "../adapters/openrouter/reconciliation.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(handler: (request: Request) => Response): { baseUrl: string; seen: string[] } {
  const seen: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      seen.push(request.headers.get("authorization") ?? "");
      return handler(request);
    },
  });
  servers.push(server);
  return { baseUrl: `http://127.0.0.1:${server.port}`, seen };
}

function configuration(
  baseUrl: string,
  overrides: Partial<OpenRouterReconciliationConfig> = {},
): OpenRouterReconciliationConfig {
  return {
    apiKey: "fixture-secret",
    baseUrl,
    currency: "USD",
    maximumResponseBytes: 1024 * 1024,
    requestTimeoutMs: 5_000,
    maximumLookups: 500,
    lookupBudgetMs: 10_000,
    indexingTimeoutMs: 2_000,
    ...overrides,
  };
}

function record(id: string, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    data: {
      id,
      model: "openai/gpt-oss-120b",
      provider_name: "Fixture",
      upstream_id: `upstream-${id}`,
      total_cost: 0.001,
      native_tokens_prompt: 10,
      native_tokens_completion: 4,
      native_tokens_cached: 3,
      native_tokens_reasoning: 2,
      ...overrides,
    },
  });
}

function requestedId(request: Request): string {
  return new URL(request.url).searchParams.get("id") ?? "";
}

describe("OpenRouter usage reconciliation", () => {
  test("reconciles billed cost and every available token class by generation id", async () => {
    const records = new Map([
      ["generation-1", { input: 10, output: 4, cached: 3, reasoning: 2, cost: 0.001 }],
      ["generation-2", { input: 20, output: 6, cached: 5, reasoning: 4, cost: 0.002 }],
    ]);
    const { baseUrl, seen } = serve((request) => {
      const id = requestedId(request);
      const found = records.get(id);
      if (!found) return Response.json({ error: "missing" }, { status: 404 });
      return record(id, {
        total_cost: found.cost,
        native_tokens_prompt: found.input,
        native_tokens_completion: found.output,
        native_tokens_cached: found.cached,
        native_tokens_reasoning: found.reasoning,
      });
    });

    const result = await reconcileOpenRouterUsage(
      {
        modelCalls: 2,
        inputTokens: 30,
        outputTokens: 10,
        cachedInputTokens: 8,
        providerRequestIds: ["generation-1", "generation-2"],
      },
      configuration(baseUrl),
      new AbortController().signal,
    );

    expect(result.cost).toEqual({ amount: 0.003, currency: "USD" });
    expect(result.reasoningTokens).toBe(6);
    expect(result.evidence).toMatchObject({
      model_calls: 2,
      input_tokens: 30,
      output_tokens: 10,
      cached_input_tokens: 8,
      reasoning_tokens: 6,
      total_cost: 0.003,
      byok: false,
    });
    expect(seen).toEqual(["Bearer fixture-secret", "Bearer fixture-secret"]);
  });

  test("fails closed when provider and generator token ledgers disagree", async () => {
    const { baseUrl } = serve((request) =>
      record(requestedId(request), { native_tokens_prompt: 9 }),
    );

    await expect(
      reconcileOpenRouterUsage(
        {
          modelCalls: 1,
          inputTokens: 10,
          outputTokens: 4,
          cachedInputTokens: 3,
          providerRequestIds: ["generation-1"],
        },
        configuration(baseUrl),
        new AbortController().signal,
      ),
    ).rejects.toThrow("disagrees with Artemis");
  });

  test("fails closed when the provider cannot report cached input tokens", async () => {
    const { baseUrl } = serve((request) =>
      record(requestedId(request), { native_tokens_cached: null }),
    );

    await expect(
      reconcileOpenRouterUsage(
        {
          modelCalls: 1,
          inputTokens: 10,
          outputTokens: 4,
          cachedInputTokens: 3,
          providerRequestIds: ["generation-1"],
        },
        configuration(baseUrl),
        new AbortController().signal,
      ),
    ).rejects.toThrow("cached-token reconciliation disagrees");
  });

  test("requires one unique provider request ID per model call", async () => {
    const { baseUrl } = serve((request) => record(requestedId(request)));
    const config = configuration(baseUrl);

    await expect(
      reconcileOpenRouterUsage(
        { modelCalls: 2, inputTokens: 10, outputTokens: 4, providerRequestIds: ["generation-1"] },
        config,
        new AbortController().signal,
      ),
    ).rejects.toThrow("one provider request ID per model call");
    await expect(
      reconcileOpenRouterUsage(
        {
          modelCalls: 2,
          inputTokens: 20,
          outputTokens: 8,
          providerRequestIds: ["generation-1", "generation-1"],
        },
        config,
        new AbortController().signal,
      ),
    ).rejects.toThrow("unique provider request IDs");
  });

  test("rejects a generation record that answers with a different identifier", async () => {
    const { baseUrl } = serve(() => record("generation-other"));

    await expect(
      reconcileOpenRouterUsage(
        { modelCalls: 1, inputTokens: 10, outputTokens: 4, providerRequestIds: ["generation-1"] },
        configuration(baseUrl),
        new AbortController().signal,
      ),
    ).rejects.toThrow("returned generation generation-other while reconciling generation-1");
  });

  test("bounds the number of generation lookups a single attempt may issue", async () => {
    const { baseUrl } = serve((request) => record(requestedId(request)));

    await expect(
      reconcileOpenRouterUsage(
        {
          modelCalls: 2,
          inputTokens: 20,
          outputTokens: 8,
          providerRequestIds: ["generation-1", "generation-2"],
        },
        configuration(baseUrl, { maximumLookups: 1 }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("above max_lookups");
  });

  test("names the generation whose native token counts the provider withheld", async () => {
    const { baseUrl } = serve((request) =>
      record(requestedId(request), { native_tokens_prompt: null }),
    );

    await expect(
      reconcileOpenRouterUsage(
        { modelCalls: 1, inputTokens: 10, outputTokens: 4, providerRequestIds: ["generation-7"] },
        configuration(baseUrl),
        new AbortController().signal,
      ),
    ).rejects.toThrow("generation generation-7 does not report native_tokens_prompt");
  });

  test("adds the upstream inference cost for a generation billed through your own key", async () => {
    const { baseUrl } = serve((request) =>
      record(requestedId(request), {
        is_byok: true,
        total_cost: 0.05,
        upstream_inference_cost: 0.95,
      }),
    );

    const result = await reconcileOpenRouterUsage(
      { modelCalls: 1, inputTokens: 10, outputTokens: 4, providerRequestIds: ["generation-1"] },
      configuration(baseUrl),
      new AbortController().signal,
    );

    expect(result.cost).toEqual({ amount: 1, currency: "USD" });
    expect(result.evidence).toMatchObject({ total_cost: 1, byok: true });
    expect(result.evidence.generations[0]).toMatchObject({
      is_byok: true,
      platform_fee: 0.05,
      upstream_inference_cost: 0.95,
      cost: 1,
    });
  });

  test("fails closed when a own-key generation hides its upstream inference cost", async () => {
    const { baseUrl } = serve((request) =>
      record(requestedId(request), { is_byok: true, total_cost: 0.05 }),
    );

    await expect(
      reconcileOpenRouterUsage(
        { modelCalls: 1, inputTokens: 10, outputTokens: 4, providerRequestIds: ["generation-9"] },
        configuration(baseUrl),
        new AbortController().signal,
      ),
    ).rejects.toThrow("generation generation-9 is billed through your own provider key");
  });

  test("retries an unindexed generation record and a rate-limited read", async () => {
    let attempts = 0;
    const { baseUrl } = serve((request) => {
      attempts += 1;
      if (attempts === 1)
        return Response.json(
          { error: "not found" },
          { status: 404, headers: { "retry-after": "0" } },
        );
      if (attempts === 2)
        return Response.json(
          { error: "slow down" },
          { status: 429, headers: { "retry-after": "0" } },
        );
      return record(requestedId(request));
    });

    const result = await reconcileOpenRouterUsage(
      { modelCalls: 1, inputTokens: 10, outputTokens: 4, providerRequestIds: ["generation-1"] },
      configuration(baseUrl),
      new AbortController().signal,
    );

    expect(attempts).toBe(3);
    expect(result.cost).toEqual({ amount: 0.001, currency: "USD" });
  });

  test("clamps a long Retry-After instead of parking the attempt", async () => {
    let attempts = 0;
    const { baseUrl } = serve(() => {
      attempts += 1;
      return Response.json(
        { error: "slow down" },
        { status: 429, headers: { "retry-after": "86400" } },
      );
    });
    const started = Date.now();

    await expect(
      reconcileOpenRouterUsage(
        { modelCalls: 1, inputTokens: 10, outputTokens: 4, providerRequestIds: ["generation-1"] },
        configuration(baseUrl, { indexingTimeoutMs: 1_000 }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("within the reconciliation budget (last HTTP 429)");
    expect(attempts).toBe(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("stops retrying an unindexed record once the indexing budget is spent", async () => {
    let attempts = 0;
    const { baseUrl } = serve(() => {
      attempts += 1;
      return Response.json({ error: "not found" }, { status: 404 });
    });

    await expect(
      reconcileOpenRouterUsage(
        { modelCalls: 1, inputTokens: 10, outputTokens: 4, providerRequestIds: ["generation-3"] },
        configuration(baseUrl, { indexingTimeoutMs: 100 }),
        new AbortController().signal,
      ),
    ).rejects.toThrow("did not serve generation generation-3 within the reconciliation budget");
    expect(attempts).toBe(1);
  });

  test("does not retry a provider error that is not an indexing lag", async () => {
    let attempts = 0;
    const { baseUrl } = serve(() => {
      attempts += 1;
      return Response.json({ error: "boom" }, { status: 500 });
    });

    await expect(
      reconcileOpenRouterUsage(
        { modelCalls: 1, inputTokens: 10, outputTokens: 4, providerRequestIds: ["generation-1"] },
        configuration(baseUrl),
        new AbortController().signal,
      ),
    ).rejects.toThrow("returned HTTP 500 for generation generation-1");
    expect(attempts).toBe(1);
  });
});
