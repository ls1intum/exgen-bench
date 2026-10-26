# Evaluation tools

The benchmark harness in [`src/`](../src) plans, generates and releases. Everything that judges a
candidate exercise lives here, as independent tools that share one repository, one lockfile and one
[evaluation protocol v1](../docs/PROCESS-EVALUATORS.md).

| Tool | Tier | Measures | Needs |
| --- | --- | --- | --- |
| [`tier1-deterministic`](tier1-deterministic/README.md) | 1 | execution oracle, construct and complexity checks, cross-artifact consistency, promise-to-test traceability | a build toolchain for the oracle; construct specifications for the static checks |
| [`tier1-model-assisted`](tier1-model-assisted/README.md) | 1 | narrow questions about the artifacts, answered by a model (not deterministic) | an OpenAI-compatible endpoint |
| [`tier1-reference`](tier1-reference/README.md) | 1 | similarity to a complete reference exercise | a reference set |
| [`tier2-judge`](tier2-judge/README.md) | 2 | didactical checklist verdicts by an LLM judge (skeleton) | — |
| [`tier3-expert-rating`](tier3-expert-rating/README.md) | 3 | expert answers to the Tier 2 checklist (planned) | an instructor |
| [`kit`](kit) | — | shared protocol harness, bundle readers, Java analysis, fixture corpus | — |

**Tier 1** tools measure the candidate's artifacts, each from its own evidence, so they can run alone
or in any combination over the same run. **Tier 2** is a separate instrument: it is run, versioned
and reported on its own and is never combined with Tier 1. **Tier 3** is not an evaluator: its
expert ratings are the ground truth the Tier 2 judge is validated against.

## Run one tool

```sh
bun run cli tools                                                    # every tool and its evaluators
bun run cli evaluate tool tier1-deterministic .exgen/runs/<id>
bun run cli evaluate tool tier1-deterministic .exgen/runs/<id> --evaluator java-oracle-gradle
bun run cli evaluate tool tier2-judge .exgen/runs/<id>
```

A tool runs its default evaluators unless `--evaluator <entry>` names others, and
`--config <entry>=<path>` replaces one evaluator's configuration. An entry is an evaluator as
`exgen tools` lists it, such as `java-oracle-gradle`. A tool that ships only a template configuration, such as the
model endpoint, refuses to run until it is given one. A copy's `process.cwd` resolves against the
copy's own directory, so point it back at the evaluator:

```sh
cp tools/tier1-model-assisted/promise-traceability-model/evaluator.yaml my-model.yaml
# in my-model.yaml: set --model and --base-url, and
# set process.cwd to tools/tier1-model-assisted/promise-traceability-model
bun run cli evaluate tool tier1-model-assisted .exgen/runs/<id> \
  --config promise-traceability-model=my-model.yaml
```

## Combine Tier 1 tools

```sh
bun run cli evaluate tier1 .exgen/runs/<id>                          # every Tier 1 tool that needs no --config
bun run cli evaluate tier1 .exgen/runs/<id> \
  --config promise-traceability-model=my-model.yaml                   # ... and the model-assisted tool
bun run cli evaluate tier1 .exgen/runs/<id> \
  --tool tier1-deterministic --tool tier1-reference                   # a chosen subset
```

A combination runs each tool's default evaluators in turn and refuses a Tier 2 tool. Without
`--tool`, a tool whose defaults need a template configuration is skipped with a note on stderr; a
named one is refused. Every configuration is loaded before the first evaluator starts, so a
combination never stops halfway for a missing file or credential.

Tool runs and `exgen evaluate process` go through the same code path and write the same append-only
journal, so they resume each other. A tool run also prints the `exgen release create` arguments that
publish what it wrote: one `--journal` per evaluator and one `--metric-cards` per card file.
`release create` keeps a card shared by two files once and refuses two different definitions under
one metric identity. Exactly one evaluator is authoritative for `strict_success`; release creation
requires that choice when several evaluators are present.

```sh
bun run cli release create .exgen/runs/<id> --output release --metadata release.json \
  <release arguments printed by the tool run> \
  --authoritative-evaluator java-oracle
```

## Identity and pinning

Each evaluator is a versioned, digest-pinned process. Its implementation digest covers every module
its `worker.ts` reaches through relative imports, including the harness modules under `src/` and the
kit, so a change anywhere an evaluator reads changes its identity. That is why evaluators import the
harness and the kit by relative path: a bare specifier would fall outside the digest.

Run `bun run evaluators:pin` after changing an evaluator implementation, suite, backend
configuration, or reference set. CI runs `bun run evaluators:check` and rejects stale identities.
An evaluator's identity covers its file paths, so relocating its files yields a new identity whose
journals start empty.

## Missing and inapplicable measurements

Reference metrics are `not_applicable` without a reference bundle, and concept metrics are
`not_applicable` without a construct specification. Metrics that require sealed tests or mutants
remain `not_applicable` until an isolated backend can combine them with a candidate. Downstream
aggregation keeps `not_applicable` distinct from missing observations.

## Layout

```text
kit/                    protocol harness, bundle readers and Java analysis shared by the evaluators
kit/fixtures/           synthetic candidates and expected outcomes shared by every tool's tests
kit/metric-cards.json   the strict-acceptance card every release carries
<tool>/tool.yaml        the tool's tier, evaluators, defaults and metric-card files
<tool>/<evaluator>/     one process evaluator: worker.ts, evaluator.yaml, SUITE.md
```

The manifests are read by [`src/evaluation/tools.ts`](../src/evaluation/tools.ts), which plans and
runs tools for the `exgen` command line.

`kit/java/` provides a Java lexer and brace-level structure recovery, not a type-resolving parser.
Its results are syntactic approximations; the source headers document the known limits.

The synthetic fixture corpus exercises the evaluator contracts in
`tests/evaluator-fixtures.test.ts`. Recorded fixture outcomes are assertions, not evidence that a
live build profile works; backend-specific tests establish that separately.
