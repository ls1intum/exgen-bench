# consistency development suite

Cross-artifact consistency: does the problem statement describe the artifacts that were generated?

## What it measures

| Metric                                         | Type                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `consistency.residual_count`                   | count                                                                         |
| `consistency.ungrounded_statement_identifiers` | count                                                                         |
| `consistency.unmentioned_public_api`           | count                                                                         |
| `consistency.contradicted_constructs`          | count                                                                         |
| `consistency.unsupported_statement_values`     | count                                                                         |
| `consistency.satisfied`                        | boolean, gates this evaluator only; `unmentioned_public_api` does not fail it |

All metrics are at version 2. Version 1 values (before the code-span and gate changes below) are not
comparable with version 2 values.

The residual classes are reported separately rather than as one opaque score, for two reasons. A
count that cannot be broken down is not actionable in a paper. And if the structured-output
consistency check (Dietrich 2025) is later dropped in as the implementation, it becomes a different
producer of the _same_ residual classes rather than a different metric.

## Residual classes

- **ungrounded statement identifier** — the statement names something in a code span that appears in
  no generated artifact, or names a package no artifact declares. A span counts as a package when
  it has three or more lowercase segments and starts like a declared package (`de.tum...` next to
  `de.tum.cit.aet.exercise`); it is compared as a whole, and a type it ends in is checked as a name.
  A span may continue over one line ending. Spans that read as prose (expected output, sentence fragments), variables the statement's
  own worked examples declare, member chains through a JDK type (`String.endsWith`), and the package
  parts of fully qualified JDK names are not checked, nor are Java keywords and placeholders such as
  `<location>`. A JDK type named on its own still is.
- **unmentioned public API** — the solution declares a type the statement never names. A weaker
  signal: it is counted but does not fail `consistency.satisfied`.
- **contradicted construct** — the statement requires or forbids a construct, and the solution does
  the opposite. Phrase matching is English and Artemis-flavoured; another language falls through and
  produces no residual, which is the conservative direction.
- **unsupported statement value** — the statement puts an integer in a code span that no test
  asserts.

## Status

Development suite. The deterministic checks require no model. A future model-assisted
implementation belongs in the Tier 1 model-assisted tool as a separate evaluator that preserves these
residual classes.

Expected-output spans such as `Bed[occupant=Anna, closed]` and standalone bracketed example lists
are data, not Java API declarations. They are excluded from identifier checks.

Bare, unqualified array element spans (for example `items[0]`) are treated as local result
placeholders, not promises that an artifact declares a variable of that name. Qualified member
references such as `this.items[0]` and `Type.items[0]`, and method calls, remain checked.
