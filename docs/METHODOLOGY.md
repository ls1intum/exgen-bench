# Methodology

This document defines what a formal exgen-bench study measures and how it handles failures,
repetitions, missing results, and publication. See the [glossary](GLOSSARY.md) for project terms.

## What is measured

The study compares complete generation systems under fixed resource limits, not language models in
isolation. One planned attempt is one observation. Systems are paired on the same case and
repetition. Repetitions belong to a case and system, and uncertainty is calculated by resampling
whole cases. Claims beyond the named cases require a separately justified sampling frame.

The primary outcome is whether one planned attempt produces a complete exercise, passes the
independent evaluator, and stays within its resource limits. The primary rate is:

```text
strict successes / planned attempts
```

This rate is the primary estimand: the quantity the study is designed to estimate.

Unstarted attempts, generation failures, abstentions, evaluator infrastructure failures, and
budget violations are not successes. Rates conditional on starting, generation, or an available
quality verdict are reported separately.

This definition follows the emphasis on explicit constructs and deployment context in
[NIST AI 800-3](https://doi.org/10.6028/NIST.AI.800-3) and the workload, repetition, and
reproducibility requirements in the
[ACM SIGSOFT benchmarking standard](https://www2.sigsoft.org/EmpiricalStandards/docs/standards).

## Experimental design

- Every compared system receives the same exercise briefs.
- Repetitions are nested within cases; the case is the resampling unit.
- Paired conditions receive the same requested seed. Whether it was honored is recorded.
- Case-replicate blocks are deterministically shuffled, as is system order within each block.
- Resource limits and comparison factors are fixed before the run.
- The evaluator and hidden suite are identical across approaches.
- Generator-side verification is part of the treatment and cannot consume hidden evaluator
  feedback.

The default analysis resamples whole cases with a paired cluster bootstrap. The release records
the seed, resample count, confidence level, and predeclared contrast. Protocol version 1 permits one
confirmatory contrast; a larger family needs a registered multiplicity procedure.

## Outcomes

Generation and evaluation have separate outcome spaces.

Generation records:

- planned, running, completed, failed, cancelled, and interrupted lifecycle states;
- succeeded, failed, abstained, or infrastructure-failed generator outcomes;
- artifact and evidence digests;
- wall time, model/tool calls, tokens, and cost when available; and
- budget compliance and missing usage fields.

Evaluation records:

- strict success or quality failure;
- infrastructure failure without a quality verdict;
- versioned metric values and denominators; and
- evaluator, suite, configuration, and evidence identities.

Secondary measures may include buildability, test execution, solution/starter behavior, task
binding, coverage, and rejection of specification-derived semantic mutants. These describe
specific properties and are not combined into a single score. Stronger tests can materially change
measured functional correctness, as demonstrated by
[EvalPlus](https://proceedings.neurips.cc/paper_files/paper/2023/hash/43e9d647ccd3e4b7b5baab53f0368686-Abstract-Conference.html).

Human-rated properties such as clarity, difficulty, and learning-objective alignment require a
blinded rubric, independent ratings, a reliability subset, and reported agreement. An LLM judge is
treated as another instrument and must be validated against expert ratings.

## Dataset

The public dataset contract records:

- a stable dataset version and case ID;
- the exercise brief visible to generators;
- tags; and
- origin, authorship, license, publication history, and known exposure.

Objectives, hidden tests, vetted reference artifacts, semantic mutants, exclusions, and limitations
belong to the independently versioned evaluator suite or restricted study materials, not the public
dataset file. The generation request is built only from the public case fields. Evaluator assets and
feedback must not enter a generator's repair loop.

Development cases and the sealed study set are versioned separately. Existing public exercises may
have appeared in model training data, so releases document known exposure without claiming that
contamination is absent.

Dataset documentation follows
[Datasheets for Datasets](https://doi.org/10.1145/3458723) and
[Data Cards](https://research.google/pubs/data-cards-purposeful-and-transparent-dataset-documentation-for-responsible-ai/).

## Reproducibility

A run records the resolved dataset, systems, target, configuration, source and lockfile hashes,
declared container images, generator descriptions, Bun version, operating system, and architecture.
During execution, attempt directories capture requests, logs, and any responses, files, or events
produced. Finished attempts also retain a validated observation and evidence manifest. The current
manifest does not verify the runner binary, container-engine settings, host resources, or actual
network and sandbox controls. A formal study therefore needs a separate record of its execution
environment before data collection.

SQLite coordinates execution but is not a publication format. A release contains normalized JSONL
and CSV, analysis summaries, metric cards, checksums,
[Croissant 1.1](https://docs.mlcommons.org/croissant/docs/croissant-spec-1.1.html) metadata, and an
[RO-Crate 1.2](https://www.researchobject.org/ro-crate/1.2/).

Public releases omit raw evaluator messages, evidence locations, local paths, runtime commands, and
arbitrary adapter parameters. Hashes can link public records to a separately retained private
archive. Text-valued public metrics require a fixed list of allowed values in their metric
description.

The repository currently refuses to create a `submitted` release. Enabling that designation
requires enforceable gates for:

1. a timestamped, frozen registration snapshot that predates collection and matches the plan;
2. terminal coverage of every planned attempt;
3. independent evaluation of every generated candidate;
4. a validated evaluator-suite manifest, including hidden-asset and toolchain digests;
5. a private raw-data archive with recorded file hashes;
6. complete dataset provenance and licensing;
7. resolved treatment and model attestations;
8. effective seed, parameter, and provider-request provenance; and
9. effective runtime and environment attestation.

Before data collection, the study must freeze its cases, hypotheses, outcomes, exclusions, retry
rules, contrasts, and sample size. Registration can use
[OSF Registrations](https://help.osf.io/article/330-welcome-to-registrations). The final artifact
should support the ACM
[artifact review and badging](https://www.acm.org/publications/policies/artifact-review-and-badging-current)
criteria.

## Reporting

Each aggregate reports its numerator, denominator, interval method, missingness, exclusions,
retries, and versioned provenance. Public views distinguish illustrative examples from exploratory
releases. Downloadable release data remains the source of record.
