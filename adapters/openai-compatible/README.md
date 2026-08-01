# OpenAI-compatible baseline adapter

This adapter uses one OpenAI-compatible chat-completion request to turn an exercise brief into a
problem statement, starter code, reference solution, and tests.

The API key is read indirectly from an environment variable named by `api_key_env`. It is never
written to the benchmark configuration or result files. One planned attempt makes at most one
provider request; the adapter does not retry generation.

Configure the provider endpoint and model in
[`examples/openai-compatible/benchmark.yaml`](../../examples/openai-compatible/benchmark.yaml), then
provide the credential through the environment:

```bash
export MODEL_PROVIDER_API_KEY='...'
bun run cli run examples/openai-compatible/benchmark.yaml
```

For a bounded OpenRouter-specific smoke treatment, use
[`examples/openrouter/benchmark.yaml`](../../examples/openrouter/benchmark.yaml).

Provider errors are recorded as infrastructure failures; invalid model output is a generation
failure. Token usage and provider request IDs are retained even when the model returns invalid
exercise JSON. Raw provider responses are not included in public release data.

## Exact provider cost

For OpenRouter, set `base_url: https://openrouter.ai/api/v1` and
`provider_reported_cost_currency: USD`. The adapter then requests OpenRouter's detailed usage and
records its provider-reported `usage.cost`; it does not recompute billing from a mutable price
catalog. This matters because routing can change the serving provider and effective rate. The
credential still belongs only in the environment variable named by `api_key_env`.

Catalog prices are reference estimates, not billing evidence. The benchmark-level
[`reference_pricing`](../../docs/REFERENCE-PRICING.md) option snapshots OpenRouter's public catalog
and reports that estimate beside, never instead of, exact cost from the provider response or
generation ledger.
