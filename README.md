<p align="center">
  <img src="./site/favicon.svg" width="88" height="88" alt="">
</p>

<h1 align="center">exgen-bench</h1>

<p align="center">
  Benchmark systems that generate complete programming exercises.
</p>

<p align="center">
  <a href="https://ls1intum.github.io/exgen-bench/">Illustrative results site</a> ·
  <a href="./docs/README.md">Documentation</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a>
</p>

> **Status:** pre-alpha. The local smoke test and public result format work. The included smoke
> evaluator checks file completeness, not whether an exercise is correct or suitable for teaching.
> The study dataset, validated evaluator, and Artemis benchmark API are not finished. No empirical
> benchmark results have been released.

## What exgen-bench does

A programming exercise usually needs a problem statement, starter code, a reference solution,
tests, and platform settings. exgen-bench compares the complete systems that produce these
artifacts—not model responses in isolation.

![Four stages of an exgen-bench run: plan, generate, evaluate, and release.](docs/images/system-overview.png)

1. A benchmark plan fixes the exercise briefs, generation systems, repetitions, and resource
   limits before execution.
2. Each generation system receives the same planned work through a process-based adapter.
3. A separately versioned evaluator checks each candidate exercise without rerunning generation.
4. The release retains every planned outcome and provides checksummed files for analysis and the
   static results site.

The [glossary](docs/GLOSSARY.md) defines these terms and their corresponding protocol fields.

## Get started

The [illustrative results site](https://ls1intum.github.io/exgen-bench/) is the fastest way to
inspect the release interface. It uses synthetic data and does not report benchmark findings.

To verify the complete local pipeline without credentials, install the
[Bun](https://bun.sh/docs/installation) version listed in [`.bun-version`](.bun-version), then run:

```sh
git clone https://github.com/ls1intum/exgen-bench.git
cd exgen-bench
bun install --frozen-lockfile
bun run smoke
```

The command runs generation, evaluation, release verification, and the static-site build. A
successful run ends with `Full pipeline passed`. It uses a fixed mock generator and checks file
integrity, not exercise quality.

After installation, preview the results site with the checked-in synthetic data:

```sh
bun run site:serve
```

The command prints the local URL.

### Run the stages yourself

Use the small example to inspect planning, execution, saved state, and evaluation separately:

```sh
bun run cli validate examples/smoke/benchmark.yaml
bun run cli plan examples/smoke/benchmark.yaml
bun run cli run examples/smoke/benchmark.yaml --id quickstart
bun run cli status .exgen/runs/quickstart
bun run cli verify .exgen/runs/quickstart
bun run cli evaluate bundle .exgen/runs/quickstart
```

Use a new run ID when repeating the example. Run `bun run cli --help` for all commands. The
`bundle` evaluator verifies the saved candidate files; it does not assess whether an exercise is
correct or suitable for teaching.

## How results are counted

![Three conditions for exercise success: complete candidate, accepted evaluation, and resource compliance.](docs/images/success-definition.png)

The primary rate is:

```text
exercise successes / planned attempts
```

A planned attempt counts as a success only when it produces a complete candidate, passes the
independent evaluation, and stays within its resource limits. Attempts that do not start, fail,
abstain, exceed a limit, or lack an evaluation result remain in the denominator but do not count as
successes. The [methodology](docs/METHODOLOGY.md) defines the outcome and missing-data rules.

## Choose your next step

| If you want to… | Read… |
| --- | --- |
| understand the components and saved data | [System design](SYSTEM-DESIGN.md) |
| design or review a formal comparison | [Methodology](docs/METHODOLOGY.md) |
| connect Artemis or Hyperion | [Artemis integration](docs/ARTEMIS-INTEGRATION.md) |
| connect another generation system | [Protocol schemas](schemas/README.md) |
| build or preview the results site | [Results-site guide](site/README.md) |
| find the meaning of a term | [Glossary](docs/GLOSSARY.md) |
| contribute a change | [Contributing guide](CONTRIBUTING.md) |

The [documentation index](docs/README.md) groups all project guides and references by task.

## Research safeguards

- Failures, abstentions, cancellations, and missing results stay separate.
- Every system in a formal comparison uses the same independent evaluator.
- The study configuration fixes the main analysis before the run.

Generated code is untrusted. Formal evaluation requires isolated Linux execution; the
[security policy](SECURITY.md) defines the trust boundaries and minimum deployment baseline.

## Support, citation, and license

Use [GitHub Issues](https://github.com/ls1intum/exgen-bench/issues) for reproducible bugs and
methodology proposals. Report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/ls1intum/exgen-bench/security/advisories/new).

The [TUM Applied Education Technologies](https://aet.cit.tum.de/) group maintains exgen-bench.
Citation metadata is in [`CITATION.cff`](CITATION.cff). Code and documentation are available under
the [MIT License](LICENSE), and participation is governed by the
[Code of Conduct](CODE_OF_CONDUCT.md).
