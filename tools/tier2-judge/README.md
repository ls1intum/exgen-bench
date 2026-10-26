# Tier 2 LLM judge

Rates the didactical quality of a candidate exercise — the properties no program analysis can
decide, such as clarity and difficulty fit — with a language model as the rater.

**Status: skeleton.** The tool, its evaluator configuration and its metric cards exist, and the
worker speaks evaluation protocol v1, but it reports every metric as `not_applicable` and measures
nothing. See [`llm-judge/SUITE.md`](llm-judge/SUITE.md) for the dimensions.

```sh
bun run cli evaluate tool tier2-judge .exgen/runs/<id>
```

Tier 2 is run, versioned and reported on its own, and `exgen evaluate tier1` refuses to include it.
The judge has no acceptance gate, so its `strict_success` only records that it answered: a release
publishes it next to an evaluator that does gate, such as `java-oracle`, and names that one with
`--authoritative-evaluator`. The judge is validated against the
[Tier 3 expert ratings](../tier3-expert-rating/README.md), and only the dimensions that reach the
agreement threshold are scored by the judge at scale.
