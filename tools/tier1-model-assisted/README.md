# Tier 1 model-assisted metrics

Measurements of the candidate's artifacts with a language model in the loop. The model answers a
narrow question about the artifacts themselves — for promise traceability, whether an assertion
would fail if a stated claim were violated — and the evaluator counts its answers.

These metrics are **not deterministic**. The model's answer decides each outcome, so the same
candidate can score differently under another model, model version or run; only the counting is
code. They stay in Tier 1 because they ask about the artifacts, including the test code, and not
about didactical quality, which is the [Tier 2 judge](../tier2-judge/README.md)'s question.

| Evaluator | Default | Measures | Additional input |
| --- | --- | --- | --- |
| [`promise-traceability-model`](promise-traceability-model/SUITE.md) | yes (template) | normative claims a model extracts from the statement, and which of them it judges the tests to witness | an OpenAI-compatible endpoint |

The shipped configuration is a template. Copy it, set `--model` and `--base-url`, point
`process.cwd` back at the evaluator directory (it resolves against the copy's directory), and pass
the copy:

```sh
cp tools/tier1-model-assisted/promise-traceability-model/evaluator.yaml my-model.yaml
# edit my-model.yaml: --model, --base-url, process.cwd: tools/tier1-model-assisted/promise-traceability-model
export PROMISE_TRACEABILITY_API_KEY=...
bun run cli evaluate tool tier1-model-assisted .exgen/runs/<id> \
  --config promise-traceability-model=my-model.yaml
```

The key is read from the environment variable the configuration names and never enters the
configuration digest or the journal. Every metric is `tier: exploratory` and unvalidated. A model
failure is an `infra_failed` evaluation the journal can retry, never a quality verdict about the
candidate.

The deterministic counterpart is
[`promise-traceability`](../tier1-deterministic/promise-traceability/README.md) in
`tier1-deterministic`; the two share only the kit's statement-and-tests reader.
