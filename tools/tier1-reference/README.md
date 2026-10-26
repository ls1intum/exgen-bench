# Tier 1 reference-based metrics

Compares a candidate exercise with a complete reference exercise for the same case. The reference
set is content-pinned: its digest is the evaluator's suite identity, so a changed reference set
cannot silently change what a journal measured.

| Evaluator | Default | Measures | Additional input |
| --- | --- | --- | --- |
| [`java-reference`](java-reference/SUITE.md) | yes | CodeBLEU and tree edit distance between the generated and the reference solution | reference set |

```sh
bun run tools/tier1-reference/cli.ts evaluate .exgen/runs/<id>
```

The shipped configuration reads the synthetic reference set in
[`../kit/fixtures/suite`](../kit/fixtures/suite). A study materializes its own from a ready
[exercise package](../../docs/EXERCISE-PACKAGES.md), points a copy of
[`java-reference/evaluator.yaml`](java-reference/evaluator.yaml) at it with `--references`, re-pins,
and passes the copy with `--config java-reference=<path>`. Without a reference bundle for a case,
every reference metric is `not_applicable`.

Golden-test and statement-embedding metrics are declared in
[`metric-cards.json`](metric-cards.json) but not implemented; they wait for an isolated backend and
an embedding model respectively.
