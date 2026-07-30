# Methodology

## What is measured

The unit under evaluation is an exercise-generation system operating under a fixed resource
budget, not a language model in isolation.

The primary outcome is whether one planned generation produces a complete exercise that passes an
independent, versioned evaluator within budget. The primary rate is:

```text
strict successes / planned attempts
```

Unstarted attempts, generation failures, abstentions, evaluator infrastructure failures, and
budget violations are not successes. Rates conditional on starting, generation, or an available
quality verdict are reported separately.

This definition follows the emphasis on explicit constructs and deployment context in
[NIST AI 800-3](https://doi.org/10.6028/NIST.AI.800-3) and the workload, repetition, and
reproducibility requirements in the
[ACM SIGSOFT benchmarking standard](https://www2.sigsoft.org/EmpiricalStandards/docs/standards).

## Experimental design

- Every compared condition receives the same briefs.
- Repetitions are nested within briefs; the brief is the resampling unit.
- Paired conditions receive the same requested seed. Whether it was honored is recorded.
- Execution order is deterministically randomized and conditions are interleaved.
- Resource budgets and treatment factors are fixed before the run.
- The evaluator and hidden suite are identical across approaches.
- Generator-side verification is part of the treatment and cannot consume hidden evaluator
  feedback.

The default analysis resamples whole briefs with a paired cluster bootstrap. The release records
the seed, resample count, confidence level, and predeclared contrast. Protocol version 1 permits one
confirmatory contrast; a larger family needs a registered multiplicity procedure.

For a larger study, a logistic mixed model such as
`success ~ approach * model + (1 | brief)` may be specified before data collection. Effect sizes
and intervals are reported regardless of the inferential method.

## Outcomes

Generation and evaluation have separate outcome spaces.

Generation records:

- planned, running, completed, failed, cancelled, and interrupted lifecycle states;
- succeeded, failed, abstained, or infrastructure-failed generator outcomes;
- artifact and evidence digests;
- wall time, model/tool calls, tokens, and cost when available; and
- budget compliance and missing usage fields.

Evaluation records:

- strict acceptance or quality failure;
- infrastructure failure without a quality verdict;
- versioned metric values and denominators; and
- evaluator, suite, configuration, and evidence identities.

Secondary measures may include buildability, test execution, solution/starter behavior, task
binding, coverage, and rejection of specification-derived semantic mutants. These describe
specific properties and are not combined into a single score. Stronger tests can materially change
measured code quality, as demonstrated by [EvalPlus](https://arxiv.org/abs/2305.01210).

Human-rated properties such as clarity, difficulty, and learning-objective alignment require a
blinded rubric, independent ratings, a reliability subset, and reported agreement. An LLM judge is
treated as another instrument and must be validated against expert ratings.

## Dataset

The public dataset contract records:

- a stable dataset version and case ID;
- the brief visible to generators;
- tags; and
- origin, authorship, license, publication history, and known exposure.

Objectives, hidden tests, vetted reference artifacts, semantic mutants, exclusions, and limitations
belong to the independently versioned evaluator suite or restricted study materials, not the public
dataset file. The generation request is built only from the public case fields. Evaluator assets and
feedback must not enter a generator's repair loop.

Development cases and the sealed study set are versioned separately. Existing public exercises may
have appeared in model training data, so releases document known exposure and near-duplicate
checks without claiming that contamination is absent.

Dataset documentation follows [Datasheets for Datasets](https://arxiv.org/abs/1803.09010) and
[Data Cards](https://research.google/pubs/data-cards-purposeful-and-transparent-dataset-documentation-for-responsible-ai/).

## Reproducibility

A formal run records exact versions and digests for the benchmark, dataset, systems, target,
evaluator, suite, configuration, source tree, lockfile, runtime, container images, and environment.
Each attempt retains its request, response, logs, artifacts, events, and evidence manifest.

SQLite coordinates execution but is not a publication format. A release contains normalized JSONL
and CSV, analysis summaries, metric cards, checksums,
[Croissant 1.1](https://docs.mlcommons.org/croissant/docs/croissant-spec-1.1.html) metadata, and an
[RO-Crate 1.2](https://www.researchobject.org/ro-crate/1.2/).

Public releases omit raw evaluator messages, evidence locations, local paths, runtime commands, and
arbitrary adapter parameters. Digests connect the public records to a restricted operational
archive. String-valued public metrics require a finite vocabulary in their metric card.

Submitted releases require:

1. a timestamped registration;
2. terminal coverage of every planned attempt;
3. independent evaluation of every generated candidate;
4. completed metric validation with evidence;
5. complete dataset provenance and licensing; and
6. effective seed, parameter, and provider-request provenance.

Before data collection, the study must freeze its cases, hypotheses, outcomes, exclusions, retry
rules, contrasts, and sample size. Registration can use
[OSF Registrations](https://help.osf.io/article/330-welcome-to-registrations). The final artifact
should support the ACM
[artifact review and badging](https://www.acm.org/publications/policies/artifact-review-and-badging-current)
criteria.

## Reporting

Each aggregate reports its numerator, denominator, interval method, missingness, exclusions,
retries, and versioned provenance. Public views distinguish exploratory, submitted, and
independently reproduced releases. Downloadable release data remains the source of record.
