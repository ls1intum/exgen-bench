# OpenRouter smoke treatment

This is a deliberately one-case, one-call configuration for validating exact OpenRouter usage and
billing capture without starting a campaign:

```bash
export OPENROUTER_API_KEY='...'
bun run cli validate examples/openrouter/benchmark.yaml
bun run cli run examples/openrouter/benchmark.yaml
```

The committed default uses `openai/gpt-oss-120b`, which was live-reachable when this treatment was
added. To test another model, create a separate pinned system revision and change both
`factors.model` and `parameters.model`; do not silently mutate a collected treatment.

OpenRouter privacy and data-policy settings can make an otherwise listed model unroutable. A
preflight failure is infrastructure evidence, not a zero-cost generation. Never put the API key in
YAML, logs, or result data.
