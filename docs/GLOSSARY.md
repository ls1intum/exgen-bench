# Glossary

This glossary defines the terms used in the documentation and public result files. Configuration
fields and JSON properties keep their published names even when the surrounding text uses a more
readable phrase.

## Core terms

### Adapter

A small program that connects a generation system to the benchmark's JSON file interface. The
adapter starts or contacts the system and returns its outcome and files.

### Approach

The generation strategy used within a system, such as a direct model call or a workflow that
plans and reviews its output. An approach is one factor of a generation system; it is not the
complete system being compared.

### Arm

One condition of a comparison: the generation system assigned to it together with the deployment
that serves it. Two arms have to be able to take part in the same run; when each needs its own
deployment, the arm and the deployment cannot be told apart, and neither can their effects.

### Attestation

A machine-readable report from a generation system of what actually served a request — its
revision, model identity, effective parameters, and effective resource limits. An attestation is
not a declaration: a value written into a benchmark configuration records an intention, and only
the system can report what ran.

### Candidate exercise

A generated exercise ready for evaluation. It contains a problem statement, starter code, a
reference solution, tests, and platform metadata. The stored directory is called a
`candidate bundle` in the protocol.

### Case

One versioned dataset entry. A case contains an exercise brief, an ID, and descriptive metadata.
Hidden tests and evaluator instructions are not part of the case shown to a generation system.

### Claim archetype

One recognised shape of promise a problem statement can make, such as *never returns null* or *does
not modify its argument*. An evaluator that reads a closed catalogue of archetypes can also report
the normative sentences it failed to classify, so its denominator can be checked rather than
trusted. Archetypes belong to one evaluator suite, not to the benchmark.

### Conformance level

How much of [SUT-REQUIREMENTS.md](SUT-REQUIREMENTS.md) a generation system meets, graded 0 to 3.
Levels are cumulative, and a study may not declare a design that depends on a requirement above the
level its systems attain.

### Dataset

A versioned collection of cases used in a benchmark. Its recorded version and file hash identify
the exact inputs used in a run.

### Evaluation

Checks applied to a candidate exercise after generation. Evaluation has its own version and can
be repeated without generating the exercise again.

### Evaluator

The program and test suite that perform an evaluation. In a formal comparison, every generation
system uses the same evaluator, and hidden evaluator feedback is not returned to the generator.

### Estimand

The quantity a study is designed to estimate, fixed before the run. exgen supports two:
`end_to_end_within_budget_strict_success_rate` for a single generation system, and
`..._difference` for the difference between two. A difference estimand needs a declared contrast
and at least two systems.

### Exercise brief

The task description given to a generation system. It states what exercise to create and may
include learning goals, constraints, or starter material. The brief does not have to be written
by an instructor. The corresponding configuration field is `brief`.

### Exercise success rate

Strict successes divided by planned attempts. This is the primary rate reported by the benchmark
and the results site. The underlying per-attempt field is `strict_success`.

### Generation system

One complete configuration being compared. It includes the adapter, approach, model, prompt or
workflow version, tools, and relevant parameters. A model alone is not a generation system.

### Metric card

The versioned description of one published metric: its construct, unit, value type, direction,
population, denominator, implementation, evidence, validation status, and limitations. A release
publishes a metric card for every metric it reports.

### Named configuration

An identified, versioned bundle of generation settings that a system publishes and a request
selects by name, instead of accepting each setting as a free-form request parameter. It is the
preferred way for a system to make the factors that define an arm selectable per request.

### Planned attempt

One scheduled combination of case, generation system, and repetition. Planned attempts are fixed
before execution and remain in the denominator even if they do not start.

### Registration

The timestamped, frozen record of a study's cases, hypotheses, outcomes, exclusions, retry rules,
contrasts, sample size, and stopping rule, written before data collection. To *predeclare* or
*preregister* a choice is to fix it in that record.

### Release

A read-only set of result files, metadata, and checksums prepared for analysis or publication.
`exgen release verify` detects changes to those files.

### Resource limits

The maximum time and, when configured, model calls, tool calls, tokens, or cost allowed for one
attempt. The configuration and protocol use the field name `budget`.

### Run

The execution of one resolved benchmark plan. A run stores progress and can continue attempts
that have not reached a final state.

### Sampling frame

The population a study's cases are drawn from and the only population its claims may describe. A
19-case development pack is its own frame; claiming more requires a separately justified one.

### Semantic mutant

A deliberately altered reference solution that a correct test suite should reject. Mutants measure
how sensitive the generated tests are; they belong to the evaluator suite, never to the public
dataset.

### Strict success

A planned attempt that produces a complete candidate exercise, passes the independent evaluator,
and stays within its resource limits. The proportion of planned attempts that reach it is the
**exercise success rate**.

### System under test

The generation system as the benchmark sees it: a black box driven only through its adapter.
Abbreviated **SUT**.

### Target

The platform and exercise format a generation system must produce, such as a particular Artemis
Java exercise format and revision.

### Target check

Platform-specific validation a generation system performs on its own output before it reports a
candidate, such as building an Artemis Java/Maven exercise and checking that the reference solution
passes its tests while the template fails them. A target check belongs to the system under test; it
is not the independent evaluation.

### Treatment

A generation system in its role as an assigned experimental condition. Use *generation system* for
the thing being run and *treatment* only when the point is the assignment: a treatment-attributable
failure is one caused by the assigned system rather than by the study infrastructure.

### Witness

An assertion in a generated test suite that could falsify one promise the problem statement makes:
it would fail if that promise were broken. A promise with no such assertion is *unwitnessed*.

Witnessed is not *exercised*. In testing, code is exercised once a test runs it, which is what
coverage measures; a test can exercise a method and assert nothing about it. Detecting a witness is
a syntactic check, so a witness shows the assertion is present and bound to the right value, not
that it would really fail.

## Stored records

### Artifact

A file produced or used by a run. Candidate artifacts have declared roles such as statement,
starter code, solution, and tests.

### Evidence

Detailed material retained to explain or audit an outcome, such as logs, tool events, and
evaluator reports. Evidence can contain restricted information and is not automatically public.

### Observation

The stored record of what happened during one planned attempt. The observation is distinct from
the planned attempt because an attempt can exist without starting.

### Provenance

Information about where data came from and which versions, settings, and tools produced it.
Public releases include a limited provenance record; private run evidence contains more detail.

### Repetition and replicate

A repetition is another planned attempt for the same case and generation system. `replicate` is
the numbered field used to identify it in configuration and result records.
