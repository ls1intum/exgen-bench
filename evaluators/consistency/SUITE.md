# consistency development suite

Cross-artifact consistency: does the problem statement describe the artifacts that were generated?

## What it measures

| Metric | Type |
| --- | --- |
| `consistency.residual_count` | count |
| `consistency.ungrounded_statement_identifiers` | count |
| `consistency.unmentioned_public_api` | count |
| `consistency.contradicted_constructs` | count |
| `consistency.unsupported_statement_values` | count |
| `consistency.satisfied` | boolean, gates this evaluator only |

The residual classes are reported separately rather than as one opaque score, for two reasons. A
count that cannot be broken down is not actionable in a paper. And if the structured-output
consistency check (Dietrich 2025) is later dropped in as the implementation, it becomes a different
producer of the *same* residual classes rather than a different metric.

## Residual classes

- **ungrounded statement identifier** — the statement names something in a code span that appears in
  no generated artifact.
- **unmentioned public API** — the solution declares a type the statement never names. A weaker
  signal; the metric card says it should not be read as an error on its own.
- **contradicted construct** — the statement requires or forbids a construct, and the solution does
  the opposite. Phrase matching is English and Artemis-flavoured; another language falls through and
  produces no residual, which is the conservative direction.
- **unsupported statement value** — the statement puts an integer in a code span that no test
  asserts.

## Status

Development suite. Non-model, so it stays in Phase 1. Should a future implementation of the check
require a model call, it moves to Phase 4 under decision D6, and these residual classes are the
interface it has to satisfy.
