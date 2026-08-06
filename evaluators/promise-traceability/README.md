# promise-traceability

An [evaluator](../../docs/GLOSSARY.md#evaluator) belonging to one study, not to the benchmark
itself. It answers one question about a
[candidate exercise](../../docs/GLOSSARY.md#candidate-exercise): *does the test suite check what the
problem statement promises?*

A promise is checked when the suite contains an assertion that could falsify it — one that would
fail if the promise were broken. This evaluator calls such an assertion a
[witness](../../docs/GLOSSARY.md#witness) and reports the promises it can find no witness for. It is
not measuring whether the tests *exercise* the code, which is what coverage measures and is a weaker
property: a test can run every line of a method and assert nothing about it.

```bash
bun run cli evaluate process <run-dir> --config evaluators/promise-traceability/config.yaml
bun run evaluators/promise-traceability/report.ts <run-dir>/evaluations/promise-traceability.jsonl
```

`report.ts` renders the journal as a table plus the list of promises it found no witness for. That
list, not the ratio, is the output a person should read.

## Why this exists

Every candidate exercise the harness accepts clears the same differential bar: the reference
solution passes the tests and the template fails them. That bar is blind to test adequacy — a suite
with three test methods clears it exactly as one with fifteen does. The worked example this
evaluator was built against is `library-checkout`, whose statement promises that `summarize` *"must
never return `null` and must never modify the supplied list"*, and whose four test methods check
neither. The differential oracle cannot see that. Neither can a review step that is part of the
generation system, which is judging its own output.

## Two layers, deliberately separated

**The deterministic layer** (`config.yaml`) uses no model and no network. It parses the Markdown
statement and the JUnit sources and computes structural evidence that is reproducible from the
candidate bytes: which normative claims have an assertion that could falsify them, which declared
API members the behavioural tests touch, whether stated exceptions have a matching `assertThrows`,
whether stated literals appear, how many assertions there are and how many test methods have none.

**The model-assisted layer** (`config.model-assisted.yaml`) extracts normative claims from prose
with a language model. It is off unless you pass `--model` and `--base-url`, every metric it
produces is `tier: exploratory`, and a model failure is reported as an infrastructure failure on
those scores alone. It never touches the deterministic scores or the response status. This split
exists because an LLM judge is an uncalibrated instrument until it has been checked against blinded
expert ratings, and this one has not been.

## What the scores mean

There is **no weighted composite** and no quality threshold. `strict_success` means the candidate
exercise was *measurable*, not that it is good; it fails only when it cannot be read. See
[`SUITE.md`](SUITE.md) for the metric list, the claim catalogue, and that warning stated in full,
and [`metric-cards.json`](metric-cards.json) for each metric's construct, denominator, and
limitations. Every metric is `validation.status: planned` with an `AUTHOR_DECLARED` method: nothing
here has been validated against human judgement.

## How claims are found

The layer recognises a closed catalogue of seven
[claim archetypes](../../docs/GLOSSARY.md#claim-archetype), each paired with a decidable
assertion-level witness (see SUITE.md for the table). A statement sentence that carries a normative
modal but matches no archetype is counted in `promise.unclassified_normative_units` rather than
dropped, so the ratio's denominator can be audited rather than trusted. Sentences that frame the
exercise — *"the template already contains…"*, *"in this exercise we work with…"* — are excluded:
they describe scaffolding, not behaviour the student must deliver.

The witness predicates are deliberately stricter than "the word appears somewhere". `assertNotNull`
only witnesses a never-null promise when it is applied to the result of a member under test;
`assertEquals(0, x)` inside a test whose *message string* mentions the argument does not witness a
non-mutation promise. Getting those two wrong was the difference between reporting `library-checkout`
as clean and reporting it as it is.

## Known blind spots

- **Not a mutation analysis.** The witness predicates are syntactic, so a witness shows an assertion
  is present and bound to the right value. It does not prove the assertion would fail if the promise
  were violated, and the metric therefore over-credits. The natural next evaluator mutates the
  reference solution and measures which mutants the suite kills.
- **A fixed catalogue.** Format promises ("always show two decimal digits"), arithmetic contracts,
  and domain rules fall outside it and land in the unclassified count.
- **Java, JUnit 5, and the Artemis structural-oracle convention only.**
- **Lexical, not semantic.** Assertions inside helper methods, parameterised-test cases, and
  behaviour reached only through reflection are partially handled and can be under-counted.

## Files

| file | role |
| --- | --- |
| `worker.ts` | protocol v1 entry point: request on stdin, response on stdout |
| `bundle.ts` | reads the statement and test tree through the declared artifact roles |
| `statement.ts` | statement segmentation, claim archetypes, API members, stated literals |
| `java-tests.ts` | JUnit parsing: behavioural vs structural lanes, assertions, literals |
| `traceability.ts` | witness predicates and the per-claim trace |
| `scores.ts` | trace to protocol scores and evidence lines |
| `model.ts` | the exploratory model-assisted layer |
| `identity.ts` | prints the implementation and suite digests the two configs must declare |
| `report.ts` | renders an evaluation journal for a human reader |

Tests live in `tests/promise-traceability.test.ts` and run against hand-built fixtures, so they need
no run directory and no corpus.
