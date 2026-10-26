# Tier 1 model-assisted metrics

Narrow measurements that use a language model as an extraction instrument: each evaluator asks the
model one bounded question about the candidate and scores the answer deterministically. This is not a
judge of quality; that is [Tier 2](../tier2-judge/README.md).

| Evaluator | Default | Measures | Additional input |
| --- | --- | --- | --- |
| [`promise-traceability-model`](promise-traceability-model/SUITE.md) | yes | normative claims a model extracts from the statement, and which of them the tests witness | an OpenAI-compatible endpoint |

The shipped configuration is a template. Copy it, set `--model` and `--base-url`, and pass the copy:

```sh
cp tools/tier1-model-assisted/promise-traceability-model/evaluator.yaml my-model.yaml
export PROMISE_TRACEABILITY_API_KEY=...
bun run tools/tier1-model-assisted/cli.ts evaluate .exgen/runs/<id> \
  --config promise-traceability-model=my-model.yaml
```

The key is read from the environment variable the configuration names and never enters the
configuration digest or the journal. Every metric is `tier: exploratory` and unvalidated until its
agreement with blinded expert ratings has been measured. A model failure is an `infra_failed`
evaluation the journal can retry, never a quality verdict about the candidate.

The deterministic half of promise traceability is a separate evaluator in
[`tier1-deterministic`](../tier1-deterministic/promise-traceability/README.md); the two share only the
kit's statement-and-tests reader.
