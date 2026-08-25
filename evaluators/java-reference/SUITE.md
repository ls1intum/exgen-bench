# java-reference development suite

Reference-based comparison of a candidate against a golden-truth exercise.

## What it measures

| Metric | Type | State |
| --- | --- | --- |
| `reference.codebleu` | proportion | implemented; `not_applicable` without a reference |
| `reference.ast_edit_distance` | proportion | implemented; 0 is identical structure |
| `reference.golden_tests_on_generated_pass_rate` | proportion | unavailable without an isolated backend for sealed tests |
| `reference.generated_tests_on_golden_pass_rate` | proportion | unavailable without an isolated backend for sealed tests |
| `reference.statement_embedding_similarity` | proportion | unavailable because no embedding model is configured |

The two similarity metrics are complementary by construction. `reference.ast_edit_distance` compares
*shape* over a structure tree whose identifiers and literals are normalised, so it is blind to
renaming. `reference.codebleu` compares surface tokens, so it is not. One moving without the other
says something specific about how a candidate differs from its reference.

CodeBLEU here implements three of its four original components as specified and replaces the fourth.
A real data-flow graph needs name resolution, which the structural analyser deliberately does not do,
so the data-flow term is replaced by an explicitly named **variable-usage match**. It correlates with
data flow and is not data flow; `components` reports every term separately and the metric card states
the substitution as a limitation.

## Golden references

Reference sets may contain restricted assets; access policy is external to the metric-neutral
`reference-set.schema.json` contract. The implemented similarity metrics select the Java `solution`
role; complete bundles retain tests for the deferred differential metrics. The data source does not
select metrics or evaluator behavior, and reference tests are never pushed to Artemis.

## Status

Development suite. One golden reference, for the `reference-pair` fixture.
