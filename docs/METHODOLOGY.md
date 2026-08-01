# Methodology

This document defines what a formal exgen-bench study measures and how it handles failures,
repetitions, missing results, and publication. See the [glossary](GLOSSARY.md) for project terms.

## What is measured

The study compares complete generation systems under fixed resource limits, not language models in
isolation. One planned attempt is one observation. Systems are paired on the same case and
repetition. Repetitions belong to a case and system, and uncertainty is calculated by resampling
whole cases. Claims beyond the named cases require a separately justified
[sampling frame](GLOSSARY.md#sampling-frame).

The primary outcome is whether one planned attempt produces a complete exercise, passes the
independent evaluator, and stays within its resource limits. The primary rate is the exercise
success rate:

```text
exercise successes / planned attempts
```

That rate is the primary [estimand](GLOSSARY.md#estimand). A single-arm study estimates the rate
itself; a comparison estimates the difference between two generation systems and must declare the
contrast that names them.

![Three conditions for exercise success: complete candidate, accepted evaluation, and resource compliance.](images/success-definition.png)

Unstarted attempts, generation failures, abstentions, evaluator infrastructure failures, and
budget violations are not successes. Rates conditional on starting, generation, or an available
quality verdict are reported separately.

Failure attribution is frozen before collection. Failures of the measured system, including its
managed verifier or sandbox, are treatment-attributable operational failures. An uncertain model
call is terminal and is never silently replayed. A host, credential, coordinator, or shared
study-infrastructure outage invalidates and replaces the entire affected randomized block under a
new identity while retaining the original record. Evaluator infrastructure may retry the same
immutable candidate, and never a quality rejection; every evaluation attempt remains in the
append-only journal, which is the record of what was tried and is never rewritten. A confirmatory
release cannot contain an unresolved study or evaluator infrastructure outcome.

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
- The evaluator and hidden suite are identical across approaches. Hidden requirements, oracles,
  reference solutions, and mutants stay outside every generation system's environment, network, and
  repair loop.
- Generator-side verification is part of the generation system and cannot consume hidden evaluator
  feedback.
- Stateful systems receive fresh logical entities and a verified generator-visible fixture for
  every attempt.
- Formal concurrency is one until an interference study rules out shared quota, cache, sandbox,
  provider-queue, and host-resource effects at the intended level.
- Every component of a compared system — image, model serving, evaluator, and toolchain — is pinned
  by content digest, and a silent substitution invalidates the affected block.

The analysis resamples whole cases: a paired cluster bootstrap for a difference between two systems,
a single-arm cluster bootstrap for one system's rate. The release records the seed, resample count,
confidence level, and predeclared contrast. Protocol version 1 permits one confirmatory contrast; a
larger family needs a registered multiplicity procedure.

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

Cases live in three separately versioned pools:

| Pool | Purpose | Exposure rule |
| --- | --- | --- |
| Development | Fast regression and root-cause iteration | Public; any inspected result stays here permanently |
| Restricted validation | Controlled instrument and approach tuning | Query-limited; moves to development once its feedback has been used |
| Sealed confirmation | Frozen claims | One-shot or tightly governed; never used for repair |

The [Hyperion development pack](../datasets/hyperion-development-v1/README.md) is the only pool that
exists today. The other two do not, so no exgen study can currently make a confirmatory claim.

Existing public exercises may have appeared in model training data, so releases document known
exposure without claiming that contamination is absent.

Paraphrases of one brief share a case family and must not be counted as independent sampling units;
resample families rather than variants. Version 1 of the development pack has no families, so this
rule has nothing to constrain there yet.

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
archive: a BagIt 1.0 bag carrying both SHA-256 and SHA-512 manifests as RFC 8493 section 2.4
requires, described in [RESTRICTED-ARCHIVES.md](RESTRICTED-ARCHIVES.md). Text-valued public metrics
require a fixed list of allowed values in their metric description.

The repository currently refuses to create a `submitted` release. Enabling that designation
requires enforceable gates for:

1. a timestamped, frozen registration snapshot that predates collection and matches the plan;
2. terminal coverage of every planned attempt;
3. independent evaluation of every generated candidate;
4. a validated evaluator-suite manifest, including hidden-asset and toolchain digests;
5. a private raw-data archive with recorded file hashes;
6. complete dataset provenance and licensing;
7. resolved generation-system and model attestations;
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

Process telemetry follows the claim-specific authority and cross-system OpenTelemetry profile in
[TELEMETRY.md](TELEMETRY.md). It supports accounting, diagnostics, and treatment-fidelity analysis;
it never substitutes for independent candidate-quality evaluation.
