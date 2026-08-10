# Evaluators

The measurement layer: the code that opens a generated Java exercise and decides something about it.
Everything here speaks [evaluation protocol v1](../docs/PROCESS-EVALUATORS.md) and runs through
`exgen evaluate process`, so an evaluator is a versioned, digest-pinned artifact rather than a
function inside the harness.

## The evaluators

| Evaluator | Decides | Needs |
| --- | --- | --- |
| [`java-oracle`](java-oracle/SUITE.md) | **the acceptance gate**: the solution passes every test, the template passes none | a build backend |
| [`java-static`](java-static/SUITE.md) | concept fidelity and complexity fit | a construct specification per case |
| [`java-reference`](java-reference/SUITE.md) | similarity to a golden reference | a golden reference per case |
| [`consistency`](consistency/SUITE.md) | whether the statement describes the artifacts | nothing |

None of the four calls a model. `java-oracle` is the only one that needs anything outside the
candidate bundle, and the backend it ships with replays recorded build results.
[`promise-traceability`](promise-traceability/README.md) — whether the tests witness what the
statement promises — belongs to one study rather than to the benchmark and is scoped in its own
README.

They run **side by side over the same immutable candidate**. Exactly one is authoritative for
`strict_success`, declared per release with `--authoritative-evaluator`; the others record their
verdicts without touching the primary estimand. A release with several evaluators and no declaration
is refused, because picking one implicitly is how a benchmark silently changes its primary outcome.

`java-oracle` builds and grades the candidates, so its configuration names a deployment:
copy `evaluators/java-oracle/config.localci.example.yaml` to `config.localci.yaml` and fill it in
first. Without it that evaluator stops with a missing-configuration error rather than reporting
anything, which is deliberate — the fixture profile it used to default to replays recordings and
measures nothing.

```bash
for e in java-oracle java-static java-reference consistency; do
  bun run cli evaluate process .exgen/runs/<id> \
    --config evaluators/$e/evaluator.yaml \
    --journal .exgen/runs/<id>/evaluations/$e.jsonl
done

bun run cli release create .exgen/runs/<id> \
  --output release --metadata release.json \
  --metric-cards evaluators/metric-cards.json \
  --journal .exgen/runs/<id>/evaluations/java-oracle.jsonl \
  --journal .exgen/runs/<id>/evaluations/java-static.jsonl \
  --journal .exgen/runs/<id>/evaluations/java-reference.jsonl \
  --journal .exgen/runs/<id>/evaluations/consistency.jsonl \
  --authoritative-evaluator java-oracle
```

Each evaluator keeps its own append-only journal, so recovery and replay stay per-evaluator; the
merge happens at release time and rejects an evaluation ID that appears in two journals.

## What `not_applicable` means here

Much of what these evaluators can measure has no ground truth yet, and the pipeline has to stay green
in that state rather than discover it at the first release. Every reference metric is
`not_applicable` without a golden reference; every concept metric is `not_applicable` for a case with
no construct specification; `mutation.score` and both differential-testing metrics are
`not_applicable` for as long as mutants and golden tests are sealed assets that must not enter the
system under test.

`not_applicable` is held apart from *missing* everywhere downstream, and every score says which of
the two it is and what it is waiting for. An aggregate that folds them together reports a coverage
gap that is not there; one that folds "not applicable" into the denominator reports a rate over a
population that never existed.

## Independence

`java-oracle`'s `localci` backend computes the acceptance gate **inside the system under test**
(decision D1). Independence is waived, not met; the deviation is recorded in
[`docs/ARTEMIS-INTEGRATION.md § Deviation`](../docs/ARTEMIS-INTEGRATION.md) and belongs in the
paper's threats section. The `BuildBackend` boundary exists so that restoring it is a configuration
change plus a re-run rather than a rewrite.

Two rules survive the waiver and are enforced in code: a timeout, an unreachable deployment or an
agent failure is `infra_failure` and never a quality verdict; and the configuration schema rejects an
evaluation course that is also a generation course. A third — that no sealed suite asset reaches
Artemis — holds only because the backend writes nothing but what the bundle reader returned. Nothing
checks it, and `shared/bundle.ts` does not yet resolve artifact roots against the bundle's real path.

## Layout

```
shared/          bundle reading, the Java analysis layer, the protocol harness
java-oracle/     evaluator core, the BuildBackend boundary, fixture and localci backends
java-static/     construct specification format and checker
java-reference/  CodeBLEU and tree edit distance
consistency/     cross-artifact residual classes
fixtures/        the candidate corpus, recorded build results, and expected verdicts
metric-cards.json  one card per metric every evaluator here can emit
```

## The Java analysis layer

`shared/java/` is a complete Java lexer plus brace-level structure recovery, and **not a parser**: a
full Java parser is the wrong dependency for a measurement instrument a reviewer has to be able to
read. It resolves no types, overloads or imports, so it is approximate in both directions — it
reports syntactic presence rather than execution, detects recursion by name, and reads some
comparison chains as generic argument lists. The `structure.ts` and `spec.ts` headers enumerate the
limits; none of them is conservative.

## The fixture corpus

`fixtures/` holds hand-authored candidate bundles in the Artemis exercise layout, one per situation
the oracle has to distinguish, each with a machine-readable `expected.json` and a recorded build
result. The corpus runs as a test suite against the evaluators (`tests/evaluator-fixtures.test.ts`).
A recording asserts what a real backend would have produced; replaying the corpus through a live
backend is what would turn that assertion into an observation.

| Fixture | What it exercises |
| --- | --- |
| `correct-exercise` | the only shape the gate may accept |
| `template-already-passes` | a template that leaves nothing to do |
| `solution-fails-tests` | a solution that fails its own suite |
| `solution-does-not-compile` | a compile failure is a *quality* fact, not infrastructure |
| `non-terminating-test` | a build timeout is infrastructure, with **no** quality verdict |
| `test-reads-forbidden-file` | a sandbox denial, and a statement value no test asserts |
| `statement-contradicts-tests` | an exercise the oracle accepts and consistency rejects |
| `reference-pair` | a candidate with a golden reference, and a case with no construct spec |
