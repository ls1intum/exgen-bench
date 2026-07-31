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

Provider errors are recorded as infrastructure failures; invalid model output is a generation
failure. Raw provider responses are not included in public release data.
