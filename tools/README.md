# Evaluation tools

The benchmark harness in [`src/`](../src) plans, generates and releases. Everything that judges a
candidate exercise lives here, as independent tools that share one repository, one lockfile and one
[evaluation protocol v1](../docs/PROCESS-EVALUATORS.md).

| Tool | Tier | Measures | Needs |
| --- | --- | --- | --- |
| [`tier1-deterministic`](tier1-deterministic/README.md) | 1 | execution oracle, construct and complexity checks, cross-artifact consistency, promise-to-test traceability | the candidate; a build toolchain for the oracle |
| [`tier1-model-assisted`](tier1-model-assisted/README.md) | 1 | narrow questions answered with a model as an extraction instrument | an OpenAI-compatible endpoint |
| [`tier1-reference`](tier1-reference/README.md) | 1 | similarity to a complete reference exercise | a reference set |
| [`tier2-judge`](tier2-judge/README.md) | 2 | holistic rubric judgement by an LLM (skeleton) | an endpoint, once implemented |
| [`survey`](survey/README.md) | — | instructor expert survey (planned) | — |
| [`kit`](kit) | — | shared protocol harness, bundle readers, Java analysis, tool runner, fixture corpus | — |

**Tier 1** tools measure the candidate itself, each from its own evidence, so they can run alone or
in any combination over the same run. **Tier 2** is a separate instrument: it is run, versioned and
reported on its own and is never combined with Tier 1. The survey is not an evaluator; it will
collect the expert ratings the model-assisted and judge tools are validated against.

## Run one tool

Every evaluation tool has its own command line and runs its default evaluators over a run directory:

```sh
bun run tools/tier1-deterministic/cli.ts list
bun run tools/tier1-deterministic/cli.ts evaluate .exgen/runs/<id>
bun run tools/tier1-reference/cli.ts evaluate .exgen/runs/<id>
bun run tools/tier2-judge/cli.ts evaluate .exgen/runs/<id>
```

The root scripts `bun run tier1:deterministic`, `tier1:model-assisted`, `tier1:reference` and
`tier2:judge` are shortcuts for the same commands. `--evaluator <id>` selects evaluators instead of
the defaults, and `--config <id>=<path>` replaces one evaluator's configuration. A tool that ships
only a template configuration, such as the model endpoint, refuses to run until it is given one:

```sh
cp tools/tier1-model-assisted/promise-traceability-model/evaluator.yaml my-model.yaml
# set --model and --base-url in my-model.yaml, then
bun run tools/tier1-model-assisted/cli.ts evaluate .exgen/runs/<id> \
  --config promise-traceability-model=my-model.yaml
```

## Combine Tier 1 tools

```sh
bun run cli evaluate tier1 .exgen/runs/<id>                          # every Tier 1 tool
bun run cli evaluate tier1 .exgen/runs/<id> \
  --tool tier1-deterministic --tool tier1-reference                   # a chosen subset
```

A combination runs each tool's default evaluators in turn and refuses a Tier 2 tool by name. It
checks every template configuration and every `--config` before anything runs, so a combination
never stops halfway for a missing endpoint. `bun run cli tools` lists every tool and its evaluators.

A tool run and a manual `exgen evaluate process` run go through the same code path and write the
same append-only journal, so they resume each other. A tool run also prints the
`exgen release create` arguments that publish what it wrote: one `--journal` per evaluator and one `--metric-cards` per
card file. `release create` merges the card files, keeps a card shared by two files once, and refuses
two different definitions under one metric identity. Exactly one evaluator is authoritative for
`strict_success`; release creation requires that choice when several evaluators are present.

```sh
bun run cli release create .exgen/runs/<id> --output release --metadata release.json \
  <release arguments printed by the tool run> \
  --authoritative-evaluator java-oracle
```

## Identity and pinning

Each evaluator is a versioned, digest-pinned process. Its implementation digest covers every module
its `worker.ts` reaches through relative imports, including the harness modules under `src/` and the
kit, so a change anywhere an evaluator reads changes its identity. That is why tools import the
harness and kit by relative path rather than as packages: a bare specifier would fall outside the
digest.

Run `bun run evaluators:pin` after changing an evaluator implementation, suite, backend
configuration, or reference set. CI runs `bun run evaluators:check` and rejects stale identities.
Moving an evaluator's files changes its digest, so journals written before a move belong to a
different evaluator identity and are not resumed by the moved one.

## Missing and inapplicable measurements

Reference metrics are `not_applicable` without a reference bundle, and concept metrics are
`not_applicable` without a construct specification. Metrics that require sealed tests or mutants
remain `not_applicable` until an isolated backend can combine them with a candidate. Downstream
aggregation keeps `not_applicable` distinct from missing observations.

## Layout

```text
kit/                    protocol harness, bundle readers, Java analysis, tool runner and CLI
kit/fixtures/           synthetic candidates and expected outcomes shared by every tool's tests
kit/metric-cards.json   the strict-acceptance card every release carries
<tool>/tool.yaml        the tool's tier, evaluators, defaults and metric-card files
<tool>/cli.ts           the tool's command line
<tool>/<evaluator>/     one process evaluator: worker.ts, evaluator.yaml, SUITE.md
```

`kit/java/` provides a Java lexer and brace-level structure recovery, not a type-resolving parser.
Its results are syntactic approximations; the source headers document the known limits.

The synthetic fixture corpus exercises the evaluator contracts in
`tests/evaluator-fixtures.test.ts`. Recorded fixture outcomes are assertions, not evidence that a
live build profile works; backend-specific tests establish that separately.
