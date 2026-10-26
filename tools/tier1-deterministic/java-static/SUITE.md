# java-static development suite

Concept fidelity and complexity fit, from the candidate bundle alone. No Artemis, no execution, no
independence question.

## What it measures

| Metric | Type | Role |
| --- | --- | --- |
| `concept.required_constructs_present` | boolean | gates this evaluator only |
| `concept.forbidden_constructs_absent` | boolean | gates this evaluator only |
| `concept.missing` | string | first missing construct, from the closed vocabulary |
| `concept.missing_count`, `concept.violated_count` | count | |
| `complexity.cyclomatic_max`, `complexity.cognitive_max` | count | measured with or without a spec |
| `complexity.within_bounds` | boolean | needs a spec to have a bound |

`concept.missing` is the first public string metric in this repository, so it needs a finite allowed
value list: the closed construct vocabulary plus `none`. When several constructs are missing it names
the first in vocabulary order, `concept.missing_count` carries the total, and the score message lists
them all for a restricted reader.

## Construct specifications

A spec is a **restricted suite asset** at `cases/<case_id>.yaml`, not a dataset field: "this exercise
must be solved with recursion" gives away the answer, and the dataset contract forbids that in the
public dataset file.

Every case without a spec scores every concept metric `not_applicable`. Complexity is still
measured, because it needs no ground truth; only the bound does.

The specs checked in here cover the fixture corpus and exist to exercise the format. Corpus specs
remain unvalidated until they receive domain review, independent second coding, and an inter-rater
agreement report.

## Analysis limits

The checker is a lexer plus brace-level structure recovery, not a Java parser. It reports syntactic
presence, not execution; recursion is detected by name, so a same-named overload would satisfy it;
and the tokens that are ambiguous without a parse are disambiguated conservatively. A `?` is a
ternary only outside a generic argument list (not a `List<?>` wildcard); `extends`/`implements` are
inheritance only outside a type bound (not `<T extends N>`); `->` is a lambda only when it is not a
switch rule (`case L ->`, `default ->`); and a stream is reported only on a real stream signal (the
`java.util.stream` package, `Collectors`, or a `.stream(`/`.parallelStream(` pipeline), so
`Optional.filter` is not one. Each limit is repeated on the corresponding metric card. All of them
under-report structure rather than invent it.

## Status

Development suite. Format and checker are complete; the specifications are fixtures only.
