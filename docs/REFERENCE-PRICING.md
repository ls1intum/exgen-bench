# Reference pricing

Provider billing and catalog pricing answer different questions. Provider billing reports what a
request actually cost. A catalog estimate reports what the observed token usage would cost at a
published rate retrieved at a particular time. Exgen keeps both when both exist; it never copies a
catalog estimate into `response.cost`, and budget assessment never reads reference pricing.

## Configuration

```yaml
reference_pricing:
  source: openrouter
  model_by_system:
    artemis: openai/gpt-oss-120b
```

The model map is needed when a system does not report one OpenRouter model ID, as with a local Logos
deployment. Without a map, exgen uses `response.model.id`. Do not map a system whose aggregate usage
combines models with different prices: exgen cannot allocate aggregate tokens between them and will
not invent that allocation.

OpenRouter's [model catalog](https://openrouter.ai/docs/overview/models) and model-endpoint API are
public, so reference pricing accepts no credential and sends no authorization header. `base_url`,
`timeout_ms`, and `max_response_bytes` are configurable for a controlled mirror or test server.

## Evidence and calculation

Exgen fetches `/models` and `/models/{model}/endpoints` once per model in a run. It retains the exact
responses under `pricing/openrouter/snapshots/`, and each attempt retains a normalized quote with:

- the requested, matched, and canonical model identifiers;
- local retrieval time and both HTTP `Date` values;
- source URLs and SHA-256 digests of both raw responses;
- prompt, completion, cache-read, and request rates as decimal strings; and
- the active endpoint provider, tag, quantization, and rate basis.

The estimate uses arbitrary-precision decimal arithmetic:

```text
(input - cached) × prompt_rate
  + cached × cache_read_rate
  + output × completion_rate
  + model_calls × request_rate
```

Missing optional rates are treated as zero only when that is unambiguous: a missing request rate
means no separate request charge, and a missing cache-read rate means input has one rate. If the
catalog has a distinct cache-read rate but the attempt has no cached-token count, the estimate is
`unavailable`; exgen does not price every input token at a convenient rate. Input and output token
counts are always required. Conditional overrides, non-zero endpoint discounts, separate reasoning
charges, and cache-write charges also make a quote unavailable until the evidence can identify and
price the applicable condition; default-rate arithmetic must not hide a rate the catalog exposes.

The analysis-ready record includes the catalog estimate, exact decimal rate strings, assumptions,
quote digest, retrieval time, model and model-source provenance, and the minimum and maximum amount
across routes whose endpoint status was active in the same snapshot. The route range describes the
catalog at retrieval time; it does not identify the route a provider actually selected. The range
is omitted unless every active route can be priced from the attempt's usage evidence; the record
publishes both the active and priced endpoint counts so that omission is explicit.

Quotes are immutable within a run. A resumed run reuses the stored quote rather than silently
repricing earlier and later attempts against different catalog states. HTTP, schema, model-match, or
usage failures produce an explicit `unavailable` reason and do not turn an otherwise valid
generation into an infrastructure failure.

## Interpretation

Use exact provider billing for invoices and cost-budget compliance. Use reference cost for model
selection, local-deployment counterfactuals, and sensitivity reporting. OpenRouter routes can have
different prices, and its catalog is mutable; the endpoint range and dated snapshot make that
uncertainty visible. The authoritative machine-readable API description is OpenRouter's
[OpenAPI document](https://openrouter.ai/openapi.json).
