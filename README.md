# exgen-bench

Evaluate systems that generate autograder-ready programming exercises from instructor briefs.

<p align="center">
  <img src="./site/social-preview.png" alt="exgen-bench overview: frozen instructor briefs and budgets pass through generation systems using approach-agnostic adapters to produce traceable evaluation, provenance, and releases.">
</p>

<p align="center">
  <a href="https://ls1intum.github.io/exgen-bench/">Illustrative dashboard</a> ·
  <a href="./docs/METHODOLOGY.md">Methodology</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

> **Project status:** pre-alpha. The deterministic smoke pipeline and public result format are
> implemented. The smoke evaluator checks bundle integrity, not correctness or educational
> quality. The study dataset, validated evaluator suite, and Artemis benchmark API are incomplete.
> No empirical benchmark results have been released.

## Why exgen-bench

A usable programming exercise is more than a model response. It includes a problem statement,
starter code, a reference solution, tests, and target-platform constraints. Comparing generation
systems therefore requires controlling briefs, budgets, target verification, and independent
evaluation while retaining failed and missing attempts.

exgen-bench is intended for computing education researchers, generation-system developers, and
maintainers of teaching platforms.

## What works today

- Schedule paired repetitions and preserve every planned outcome.
- Run generation systems through language-neutral, out-of-process adapters.
- Re-evaluate generated bundles without repeating generation.
- Export and verify versioned releases for the static results site.

## Try it locally

Install the [Bun](https://bun.sh/docs/installation) version listed in
[`.bun-version`](.bun-version), then:

```bash
git clone https://github.com/ls1intum/exgen-bench.git
cd exgen-bench
bun install --frozen-lockfile
bun run smoke
```

The smoke test uses a deterministic mock generator, requires no credentials, and verifies the
local pipeline. It does not assess exercise quality. Run `bun run cli --help` to see the available
commands.

## Run an example

The checked-in smoke benchmark uses one brief and the mock generator:

```bash
bun run cli validate examples/smoke/benchmark.yaml
bun run cli plan examples/smoke/benchmark.yaml
bun run cli run examples/smoke/benchmark.yaml --id quickstart
bun run cli status .exgen/runs/quickstart
bun run cli evaluate bundle .exgen/runs/quickstart
```

Choose a new run ID when repeating the example. The bundle evaluator is a development integrity
check, not a scientific quality evaluator. See the [results-site guide](site/README.md) to export
and present a verified release.

## How it works

The runner schedules paired repetitions and records every outcome. Generator adapters implement
the system under test, target verifiers check platform constraints, and separately versioned
evaluators inspect candidate bundles. The results site presents precomputed, checksummed release
data.

| Integration | Status | Purpose |
| --- | --- | --- |
| [Mock generator](examples/mock-generator.ts) | Included | Deterministic development and CI |
| [OpenAI-compatible adapter](adapters/openai-compatible/) | Included | Single-call baseline |
| [Artemis adapter](adapters/artemis/) | Client implemented against a proposed API | Whole-exercise generation and canonical verification |

The adapter protocol and schemas are published in [`schemas/protocol/`](schemas/protocol/). The
[system design](SYSTEM-DESIGN.md) explains component boundaries, persistence, and lifecycle
invariants. The [Artemis integration](docs/ARTEMIS-INTEGRATION.md) specifies the platform changes
required for a formal campaign.

## Measurement principles

- Planned attempts define the primary denominator.
- Failed, abstained, cancelled, and missing outcomes remain distinct.
- Generator and evaluator identities are versioned separately.
- Formal comparisons use the same independent evaluator for every approach.
- Resource-budget violations cannot count as primary successes.
- Confirmatory analyses and contrasts are fixed in the benchmark configuration.

See the [methodology](docs/METHODOLOGY.md) for the estimand, experimental design, outcome handling,
and reporting rules.

Generated code is untrusted. Formal evaluation requires isolated Linux execution; see the
[security policy](SECURITY.md). Contributions are described in
[CONTRIBUTING.md](CONTRIBUTING.md).

Use [GitHub Issues](https://github.com/ls1intum/exgen-bench/issues) for bugs and methodology
proposals. Report vulnerabilities privately as described in the security policy.

The TUM Applied Education Technologies group maintains exgen-bench. Citation metadata is in
[`CITATION.cff`](CITATION.cff). Code and documentation are available under the
[MIT License](LICENSE).
