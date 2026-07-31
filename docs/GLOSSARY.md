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

### Candidate exercise

A generated exercise ready for evaluation. It contains a problem statement, starter code, a
reference solution, tests, and platform metadata. The stored directory is called a
`candidate bundle` in the protocol.

### Case

One versioned dataset entry. A case contains an exercise brief, an ID, and descriptive metadata.
Hidden tests and evaluator instructions are not part of the case shown to a generation system.

### Dataset

A versioned collection of cases used in a benchmark. Its recorded version and file hash identify
the exact inputs used in a run.

### Evaluation

Checks applied to a candidate exercise after generation. Evaluation has its own version and can
be repeated without generating the exercise again.

### Evaluator

The program and test suite that perform an evaluation. In a formal comparison, every generation
system uses the same evaluator, and hidden evaluator feedback is not returned to the generator.

### Exercise brief

The task description given to a generation system. It states what exercise to create and may
include learning goals, constraints, or starter material. The brief does not have to be written
by an instructor. The corresponding configuration field is `brief`.

### Generation system

One complete configuration being compared. It includes the adapter, approach, model, prompt or
workflow version, tools, and relevant parameters. A model alone is not a generation system.

### Planned attempt

One scheduled combination of case, generation system, and repetition. Planned attempts are fixed
before execution and remain in the denominator even if they do not start.

### Release

A read-only set of result files, metadata, and checksums prepared for analysis or publication.
`exgen release verify` detects changes to those files.

### Resource limits

The maximum time and, when configured, model calls, tool calls, tokens, or cost allowed for one
attempt. The configuration and protocol use the field name `budget`.

### Run

The execution of one resolved benchmark plan. A run stores progress and can continue attempts
that have not reached a final state.

### Strict success

A planned attempt that produces a complete candidate exercise, passes the independent evaluator,
and stays within its resource limits. The results site labels the corresponding proportion
**exercise success rate**.

### Target

The platform and exercise format a generation system must produce, such as a particular Artemis
Java exercise format and revision.

### Target check

Platform-specific validation performed before or alongside evaluation, such as checking an
Artemis Java/Maven/Ares exercise. Artemis calls its reusable implementation the
`canonical verifier`.

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
