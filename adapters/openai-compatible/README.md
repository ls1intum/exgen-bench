# OpenAI-compatible baseline adapter

This adapter turns a visible brief into the four canonical Artemis artifact roles with one
OpenAI-compatible chat-completion request.

The API key is read indirectly from an environment variable named by `api_key_env`. It is never
written to the benchmark configuration or result bundle. One planned observation results in at
most one provider sample; the adapter does not retry generation.

Configure the provider endpoint and model in
[`examples/openai-compatible/benchmark.yaml`](../../examples/openai-compatible/benchmark.yaml), then
provide the credential through the environment:

```bash
export MODEL_PROVIDER_API_KEY='...'
bun run cli run --config examples/openai-compatible/benchmark.yaml
```

Provider errors are recorded as infrastructure failures; invalid model output is a generation
failure. Raw provider responses are not included in public release data.
