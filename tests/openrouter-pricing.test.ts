import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { generationResponseSchema } from "../src/contracts.ts";
import { referenceCostFields } from "../src/evaluation/reference-cost.ts";
import { OpenRouterReferencePricing } from "../src/pricing/openrouter.ts";

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.stop(true);
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

function response(cachedInputTokens?: number) {
  return generationResponseSchema.parse({
    protocol_version: "2",
    status: "failed",
    artifacts: [],
    capture: { completeness: "none" },
    model: { provider: "logos", id: "local-name" },
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      model_calls: 2,
      ...(cachedInputTokens === undefined ? {} : { cached_input_tokens: cachedInputTokens }),
    },
  });
}

async function fixture(
  options: {
    cacheRate?: string;
    endpointCacheRate?: string;
    pricingOverrides?: Record<string, unknown>;
  } = {},
) {
  const requested: string[] = [];
  const pricing = {
    prompt: "0.000000037",
    completion: "0.00000017",
    ...(options.cacheRate === undefined ? {} : { input_cache_read: options.cacheRate }),
    ...options.pricingOverrides,
  };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requested.push(new URL(request.url).pathname);
      if (request.headers.has("authorization")) return new Response(null, { status: 400 });
      if (new URL(request.url).pathname === "/models") {
        return Response.json(
          {
            data: [
              {
                id: "openai/gpt-oss-120b",
                canonical_slug: "openai/gpt-oss-120b",
                pricing,
              },
            ],
          },
          { headers: { date: "Sat, 01 Aug 2026 12:00:00 GMT" } },
        );
      }
      return Response.json(
        {
          data: {
            endpoints: [
              {
                provider_name: "cheap",
                tag: "cheap/gpt-oss",
                quantization: "fp8",
                status: 0,
                pricing: {
                  prompt: "0.00000003",
                  completion: "0.00000010",
                  ...(options.endpointCacheRate === undefined
                    ? {}
                    : { input_cache_read: options.endpointCacheRate }),
                },
              },
              {
                provider_name: "expensive",
                tag: "expensive/gpt-oss",
                status: 0,
                pricing: { prompt: "0.00000005", completion: "0.00000020" },
              },
              {
                provider_name: "offline",
                tag: "offline/gpt-oss",
                status: -2,
                pricing: { prompt: "0.1", completion: "0.1" },
              },
            ],
          },
        },
        { headers: { date: "Sat, 01 Aug 2026 12:00:01 GMT" } },
      );
    },
  });
  servers.push(server);
  const directory = await mkdtemp(join(tmpdir(), "exgen-pricing-"));
  directories.push(directory);
  return {
    directory,
    requested,
    pricing: new OpenRouterReferencePricing(directory, {
      base_url: `http://127.0.0.1:${server.port}`,
      timeout_ms: 5_000,
      max_response_bytes: 1024 * 1024,
      model_by_system: { artemis: "openai/gpt-oss-120b" },
    }),
  };
}

describe("OpenRouter reference pricing", () => {
  test("persists a reproducible catalog quote without treating it as provider billing", async () => {
    const { directory, requested, pricing } = await fixture();
    const attempt = join(directory, ".work", "attempt");
    const result = await pricing.price("artemis", response(0), attempt);

    expect(result).toMatchObject({
      status: "estimated",
      amount: 0.0000071,
      currency: "USD",
      source: "openrouter_model_catalog",
      model: "openai/gpt-oss-120b",
      model_source: "configured",
      active_endpoint_amount_range: { minimum: 0.000005, maximum: 0.000009 },
    });
    expect(referenceCostFields(result)).toMatchObject({
      reference_cost_status: "estimated",
      reference_cost_amount: 0.0000071,
      reference_cost_active_endpoint_min: 0.000005,
    });
    expect(referenceCostFields(undefined)).toMatchObject({
      reference_cost_status: null,
      reference_cost_unavailable_reason: null,
    });
    expect(requested).toEqual(["/models", "/models/openai/gpt-oss-120b/endpoints"]);
    const quote = JSON.parse(await readFile(join(attempt, "reference-pricing.json"), "utf8"));
    const catalogSnapshotPath = String(quote.catalog_snapshot_path);
    expect(quote).toMatchObject({
      retrieved_at: expect.any(String),
      catalog_http_date: "2026-08-01T12:00:00.000Z",
      endpoints_http_date: "2026-08-01T12:00:01.000Z",
      catalog_response_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      endpoints_response_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      catalog_snapshot_path: expect.stringMatching(/^pricing\/openrouter\/snapshots\//),
      endpoints_snapshot_path: expect.stringMatching(/^pricing\/openrouter\/snapshots\//),
    });

    const resumed = new OpenRouterReferencePricing(directory, {
      base_url: "http://unused.invalid",
      timeout_ms: 1,
      max_response_bytes: 1024 * 1024,
      model_by_system: { artemis: "openai/gpt-oss-120b" },
    });
    await expect(
      resumed.price("artemis", response(0), join(directory, ".work", "second")),
    ).resolves.toMatchObject({
      status: "estimated",
      amount: 0.0000071,
    });
    expect(requested).toHaveLength(2);

    await writeFile(join(directory, catalogSnapshotPath), "{}\n");
    const corrupted = new OpenRouterReferencePricing(directory, {
      base_url: "http://unused.invalid",
      timeout_ms: 1,
      max_response_bytes: 1024 * 1024,
      model_by_system: { artemis: "openai/gpt-oss-120b" },
    });
    const corruptedResult = await corrupted.price(
      "artemis",
      response(0),
      join(directory, ".work", "third"),
    );
    expect(corruptedResult.status === "unavailable" ? corruptedResult.reason : "").toContain(
      "snapshot digest mismatch",
    );
  });

  test("refuses to guess when the catalog discounts cache reads but usage omits them", async () => {
    const { directory, pricing } = await fixture({ cacheRate: "0.00000001" });
    const result = await pricing.price("artemis", response(), join(directory, ".work", "attempt"));
    expect(result).toEqual({
      status: "unavailable",
      source: "openrouter_model_catalog",
      reason: "the catalog has a cache-read rate but cached input tokens are unavailable",
    });
    expect(referenceCostFields(result)).toMatchObject({
      reference_cost_status: "unavailable",
      reference_cost_amount: null,
      reference_cost_unavailable_reason:
        "the catalog has a cache-read rate but cached input tokens are unavailable",
    });
  });

  test("omits the route range unless every active endpoint can be priced", async () => {
    const { directory, pricing } = await fixture({ endpointCacheRate: "0.00000001" });
    await expect(
      pricing.price("artemis", response(), join(directory, ".work", "attempt")),
    ).resolves.toMatchObject({
      status: "estimated",
      amount: 0.0000071,
      active_endpoint_amount_range: null,
    });
  });

  test("rejects a catalog default when conditional pricing could supersede it", async () => {
    const { directory, pricing } = await fixture({
      pricingOverrides: { overrides: [{ min_prompt_tokens: 10, prompt: "0.1" }] },
    });
    const result = await pricing.price("artemis", response(0), join(directory, ".work", "attempt"));
    expect(result).toMatchObject({ status: "unavailable" });
    expect(result.status === "unavailable" ? result.reason : "").toContain("conditional overrides");
  });
});
