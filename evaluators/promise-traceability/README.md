# promise-traceability

An [evaluator](../../docs/GLOSSARY.md#evaluator) belonging to one study, not to the benchmark
itself. It answers one question about a
[candidate exercise](../../docs/GLOSSARY.md#candidate-exercise): *does the test suite check what the
problem statement promises?*

A promise is checked when the suite contains an assertion that would fail if the promise were
broken. This evaluator calls such an assertion a [witness](../../docs/GLOSSARY.md#witness) — which
is not the same as *exercised*, and is not what coverage measures — and reports the promises it can
find no witness for.

```bash
bun run cli evaluate process <run-dir> --config evaluators/promise-traceability/evaluator.yaml
bun run evaluators/promise-traceability/report.ts \
  <run-dir>/evaluations/promise-traceability-promise-traceability-study-*.jsonl
```

`report.ts` renders the journal as a table plus the list of promises it found no witness for. That
list, not the ratio, is the output a person should read. For a committed run, score it with
[`scripts/score-run.ts`](../../runs/README.md#scoring-a-committed-run) instead.

## Scope

A [target check](../../docs/GLOSSARY.md#target-check) belongs to the system under test: before it
reports a candidate, an Artemis-style generator builds the exercise and checks that the reference
solution passes the tests while the template fails them. That bar is blind to test adequacy — a
four-method suite clears it exactly as a fifteen-method suite does — and neither it nor a review
step inside the same generation system can see a stated behaviour that no assertion covers. This
suite reports that gap and names the promises it believes are unwitnessed. `library-checkout` in
[`runs/hyperion-development-v1-live-20260731d`](../../runs/hyperion-development-v1-live-20260731d/README.md)
is the worked case: its statement requires that `summarize` never return `null` and never modify the
supplied list, and its four test methods check neither.

**`strict_success` here means the candidate was measurable, not that it is good.** There is no
weighted composite and no quality threshold, because none has been calibrated against human
judgement. Do not wire this suite into a `strict-acceptance` denominator or report it as an
acceptance rate; read the per-claim evidence. Every metric is `validation.status: planned` with an
`AUTHOR_DECLARED` method.

## Layers

**Deterministic** (`evaluator.yaml`) uses no model and no network. It parses the Markdown statement and
the JUnit sources and computes structural evidence reproducible from the candidate bytes: which
normative claims have an assertion that could falsify them, which declared API members the
behavioural tests touch, whether stated exceptions have a matching `assertThrows`, whether stated
literals appear, how many assertions there are and how many test methods have none.

**Model-assisted** (`evaluator.model-assisted.yaml`) extracts normative claims from prose with a
language model. It is off unless you pass `--model` and `--base-url`, every metric it produces is
`tier: exploratory`, and a model failure is reported as an infrastructure failure on those scores
alone. It never touches the deterministic scores or the response status. The split exists because an
LLM judge is an uncalibrated instrument until it has been checked against blinded expert ratings,
and this one has not been.

See [`SUITE.md`](SUITE.md) for the metric list and the claim catalogue, and
[`metric-cards.json`](metric-cards.json) for each metric's construct, denominator, and limitations.

## Blind spots

- **Not a mutation analysis.** The witness predicates are syntactic, so a witness shows an assertion
  is present and bound to the right value. It does not prove the assertion would fail if the promise
  were violated, and the metric therefore over-credits. The natural next evaluator mutates the
  reference solution and measures which mutants the suite kills.
- **A fixed catalogue.** Format promises ("always show two decimal digits"), arithmetic contracts,
  and domain rules fall outside it and land in `promise.unclassified_normative_units`.
- **Java, JUnit 5, and the Artemis structural-oracle convention only.**
- **Lexical, not semantic.** Assertions inside helper methods, parameterised-test cases, and
  behaviour reached only through reflection are partially handled and can be under-counted.

## Files

| file | role |
| --- | --- |
| `worker.ts` | protocol v1 entry point: request on stdin, response on stdout |
| `bundle.ts` | reads the statement and test tree through the declared artifact roles |
| `statement.ts` | statement segmentation, claim archetypes, API members, stated literals |
| `java-tests.ts` | Java lexer, JUnit parsing, behavioural and structural lanes, assertions, literals |
| `traceability.ts` | witness predicates and the per-claim trace |
| `scores.ts` | trace to protocol scores and evidence lines |
| `model.ts` | the exploratory model-assisted layer |
| `evaluator.yaml`, `evaluator.model-assisted.yaml` | the two published configurations |
| `identity.ts` | prints the implementation and suite digests the two configs must declare |
| `report.ts` | renders an evaluation journal for a human reader |

Tests live in `tests/promise-traceability.test.ts` and run against hand-built fixtures, so they need
no run directory and no committed run.
