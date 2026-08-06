# Evaluators

The measurement layer of the tiered evaluation design: the code that opens a generated Java exercise
and decides something about it. Everything here speaks
[evaluation protocol v1](../docs/PROCESS-EVALUATORS.md) and runs through
`exgen evaluate process`, so an evaluator is a versioned, digest-pinned artifact rather than a
function inside the harness.

This is Phase 1 of [the evaluation completion plan](../../evaluation-completion-plan.md): everything
that needs no external input. Nothing here calls a model (decision D6), and nothing here needs a live
Artemis (decision D2) — the oracle runs against recorded build results until Phase 2.

## The evaluators

| Evaluator | Decides | Needs |
| --- | --- | --- |
| [`java-oracle`](java-oracle/SUITE.md) | **the benchmark's acceptance gate**: solution passes all tests, template passes none | a build backend |
| [`java-static`](java-static/SUITE.md) | concept fidelity and complexity fit | a construct specification per case |
| [`java-reference`](java-reference/SUITE.md) | similarity to a golden-truth reference | a golden reference per case |
| [`consistency`](consistency/SUITE.md) | whether the statement describes the artifacts | nothing |

They run **side by side over the same immutable candidate**. Exactly one is authoritative for
`strict_success`, declared per release with `--authoritative-evaluator`; the others record their
verdicts without touching the primary estimand. Without a declaration a multi-evaluator release
refuses to guess, because picking one implicitly is how a benchmark silently changes its primary
outcome between releases.

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

A large share of what these evaluators can measure is not measurable yet, and the plan is explicit
that the pipeline must stay green in that state rather than discover it at the first release. So:

- every reference metric is `not_applicable` until the golden set arrives (input I4, WP10);
- every concept metric is `not_applicable` for a case with no construct specification, which is every
  real case until WP9;
- `mutation.score` and both differential-testing metrics are `not_applicable` until the container
  backend (WP2c), because mutants and golden tests are sealed assets that must not enter Artemis.

`not_applicable` is held apart from *missing* everywhere downstream. An aggregate that folds the two
together reports a coverage gap that is not there; one that folds "not applicable" into the
denominator reports a rate over a population that never existed. Every score carries a message saying
which of the two it is and what it is waiting for.

## Independence

The `java-oracle` evaluator's `localci` backend computes the acceptance gate **inside the system
under test** (decision D1). Independence is waived, not met; the deviation from this repository's own
rule is recorded in [`docs/ARTEMIS-INTEGRATION.md § Deviation`](../docs/ARTEMIS-INTEGRATION.md) and
belongs in the paper's threats section. The backend boundary exists so that restoring independence
later is a configuration change plus a re-run rather than a rewrite.

Three rules survive the waiver and are enforced in code, not documented as intentions:

1. Sealed suite assets never enter Artemis. Only content the candidate itself produced is pushed.
2. A timeout, an unreachable deployment or an agent failure is `infra_failure`, never a quality
   verdict.
3. The evaluation course must differ from every generation course.

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

`shared/java/` is a complete Java lexer plus brace-level structure recovery. It is deliberately **not
a parser**: a full Java parser is the wrong dependency for a measurement instrument that a reviewer
has to be able to read, and a lexer plus structure recovery answers every question the Phase 1
metrics ask. The limits — syntactic presence rather than execution, name-based recursion detection,
conservative generics detection — are stated on every metric card that depends on them, and all of
them under-report structure rather than invent it.

## The fixture corpus

`fixtures/` holds hand-authored candidate bundles in the Artemis exercise layout, one per situation
the oracle has to distinguish, each with a machine-readable `expected.json` and a recorded build
result. The corpus runs as a test suite against the evaluators
(`tests/evaluator-fixtures.test.ts`), which is the acceptance criterion for WP1.

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

When the live backend arrives in Phase 2 the same fixtures replay through it, and any disagreement is
a fixture defect to correct (WP8) rather than a rewrite — which is the point of building the backend
boundary before the backend.
