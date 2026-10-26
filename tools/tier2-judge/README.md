# Tier 2 LLM judge

A holistic rubric judgement of a complete candidate exercise — statement, template, solution and
tests together — with a language model as the rater.

**Status: skeleton.** The tool, its command line, its evaluator configuration and its metric cards
exist, and the worker speaks evaluation protocol v1, but every rubric metric is reported as
`not_applicable`. Nothing is measured yet. See [`llm-judge/SUITE.md`](llm-judge/SUITE.md) for the
planned rubric.

```sh
bun run tools/tier2-judge/cli.ts evaluate .exgen/runs/<id>
```

Tier 2 is run, versioned and reported on its own. `exgen evaluate tier1` refuses to include it, and
its gate is null, so it can never decide `strict_success`. The rubric dimensions are placeholders,
to be fixed together with the [instructor expert survey](../survey/README.md) the judge will be
calibrated against.
