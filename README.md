# exgen-bench

exgen-bench runs the same programming-exercise generation tasks across different systems, records
every outcome, and prepares the generated exercises for separate evaluation.

> **Status:** pre-alpha. The local smoke test and public result format work. The included smoke
> evaluator checks file completeness, not whether an exercise is correct or suitable for teaching.
> The study dataset, validated evaluator, and Artemis benchmark API are not finished. No empirical
> benchmark results have been released.

<p align="center">
  <img src="./site/social-preview.png" alt="exgen-bench workflow from exercise briefs to evaluation results.">
</p>

<p align="center">
  <a href="https://ls1intum.github.io/exgen-bench/">Illustrative results site</a> ·
  <a href="./docs/README.md">Documentation</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

## Why benchmark complete exercises?

A programming exercise usually needs a problem statement, starter code, a reference solution,
tests, and platform settings. Comparing generation systems therefore requires more than comparing
model responses. Each system must receive the same tasks and resource limits, and failures must
remain in the results.

exgen-bench provides a shared runner and file format for these comparisons. It is intended for
computing education researchers, developers of generation systems, and teaching-platform
maintainers.

## How it works

![Four stages of an exgen-bench run: plan, generate, evaluate, and release.](docs/images/system-overview.png)

1. A dataset supplies versioned **exercise briefs**: the task descriptions visible to every
   generation system.
2. Each **generation system** receives the same cases, repetitions, and resource limits.
3. Successful generation produces a **candidate exercise** containing the statement, starter code,
   reference solution, tests, and platform metadata.
4. A separately versioned **evaluator** checks each candidate. The release keeps successes,
   failures, missing results, and resource use.

The [glossary](docs/GLOSSARY.md) defines these terms and their corresponding protocol fields.

## What is included?

- A runner that schedules the same cases across systems and can continue an interrupted run.
- A process-based interface for connecting generation systems written in any language.
- Separate evaluation, so generated exercises can be checked again without rerunning generation.
- Release files with checksums for analysis and the static results site.

## Try it locally

Install the [Bun](https://bun.sh/docs/installation) version listed in
[`.bun-version`](.bun-version), then run the credential-free smoke test:

```bash
git clone https://github.com/ls1intum/exgen-bench.git
cd exgen-bench
bun install --frozen-lockfile
bun run smoke
```

The smoke test uses a fixed mock generator. It checks the complete local workflow but does not
measure exercise quality.

Preview the results site with the checked-in synthetic data:

```bash
bun run site:serve
```

The command prints the local URL. The displayed values demonstrate the interface and are not
benchmark results.

## Run the small example

The checked-in example contains one exercise brief and one mock generation system:

```bash
bun run cli validate examples/smoke/benchmark.yaml
bun run cli plan examples/smoke/benchmark.yaml
bun run cli run examples/smoke/benchmark.yaml --id quickstart
bun run cli status .exgen/runs/quickstart
bun run cli evaluate bundle .exgen/runs/quickstart
```

Use a new run ID if you repeat the example. The `bundle` evaluator checks that the expected files
exist; it is not a scientific evaluator. Run `bun run cli --help` for the complete command list.

## What counts as exercise success?

![Three conditions for exercise success: complete candidate, accepted evaluation, and resource compliance.](docs/images/success-definition.png)

The primary rate is:

```text
exercise successes / planned attempts
```

A planned attempt counts as a success only when it produces a complete candidate, passes the
independent evaluation, and stays within its resource limits. Attempts that do not start, fail,
abstain, exceed a limit, or lack an evaluation result remain in the denominator but do not count as
successes. The [methodology](docs/METHODOLOGY.md) defines the outcome and missing-data rules.

## Documentation

| If you want to… | Read… |
| --- | --- |
| understand the components and saved data | [System design](SYSTEM-DESIGN.md) |
| understand the study design and outcome rules | [Methodology](docs/METHODOLOGY.md) |
| connect Artemis or Hyperion | [Artemis integration](docs/ARTEMIS-INTEGRATION.md) |
| connect another generation system | [Protocol schemas](schemas/README.md) |
| build or preview the results site | [Results-site guide](site/README.md) |
| find the meaning of a term | [Glossary](docs/GLOSSARY.md) |

## Comparison rules

- Failures, abstentions, cancellations, and missing results stay separate.
- Every system in a formal comparison uses the same independent evaluator.
- The study configuration fixes the main analysis before the run.

Generated code is untrusted. Formal evaluation requires isolated Linux execution; see the
[security policy](SECURITY.md). Use
[GitHub Issues](https://github.com/ls1intum/exgen-bench/issues) for bugs and methodology proposals,
and report vulnerabilities privately.

The TUM Applied Education Technologies group maintains exgen-bench. Citation metadata is in
[`CITATION.cff`](CITATION.cff). Code and documentation are available under the
[MIT License](LICENSE).
