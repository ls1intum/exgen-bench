# Expert rating survey demo

A synthetic, CC0-licensed demo for the Tier 3 survey and its tests. The four introductory Java
exercises under `candidates/` are invented and contain deliberate flaws (unstated boundary rules,
paraphrased output formats, tests without messages, a template that gives the concept away), so the
survey has something for a rater to find. `generator.ts` copies them deterministically; the matching
build results are replayed from `tools/kit/fixtures/oracle-recordings/<case-id>.json`, so no Maven
and no credentials are needed.

`bun run survey:demo` runs every step with a fresh database and writes the personal links to
`.exgen/survey-demo/links.json`. By hand, the steps are:

```bash
bun run cli run tools/tier3-expert-rating/demo/benchmark.yaml --id survey-demo
bun run cli evaluate tool tier1-deterministic .exgen/runs/survey-demo \
  --config java-oracle=tools/tier1-deterministic/java-oracle/evaluator.fixture.yaml
bun run cli survey build tools/tier3-expert-rating/demo
bun run cli survey link tools/tier3-expert-rating/demo --db .exgen/survey-demo.sqlite \
  --url http://127.0.0.1:4180 --rater R1 --admin
bun run cli survey serve tools/tier3-expert-rating/demo --db .exgen/survey-demo.sqlite \
  --insecure-cookies
```

[`study.yaml`](study.yaml) plans one main rater, one reserve rater, and one test rater per browser
for the end-to-end tests. `build.allow_fixture_oracle` lets the demo use the recorded oracle; a real
study refuses it.
