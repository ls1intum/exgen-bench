# Artemis integration design

> **Status:** design proposal. Artemis does not implement this benchmark API yet. Related Hyperion
> implementation: [Artemis PR #13156](https://github.com/ls1intum/Artemis/pull/13156).

## Decision

Artemis authoring and benchmark runs should use the same generation and verification code. They
differ only in what happens to the completed exercise:

| Step | Artemis authoring | Benchmark run |
| --- | --- | --- |
| Input | Exercise brief and platform settings | The same exercise brief and platform settings |
| Generate | Produce a candidate exercise | Produce a candidate exercise |
| Check | Run the shared Artemis verifier | Run the same shared Artemis verifier, then the study evaluator |
| Store | Create or update a live exercise | Save a versioned attempt without changing a live course |

The benchmark does not copy Artemis checking logic or use live course data as its result store. A
fixed Artemis revision can provide the exercise format and platform checks without determining how
the exercise is generated.

## Artemis boundaries

The Artemis refactoring should separate three responsibilities:

- a generation core that resolves an approach and produces a candidate;
- a candidate verifier that applies a named set of platform checks; and
- an output handler that either saves a live exercise or stores benchmark files.

The values crossing these boundaries have distinct responsibilities:

- `GenerationInput` carries the caller's attempt ID, exercise brief, starter material, target,
  approach, and resource limits.
- `CandidateBundle` contains the statement, template, solution, tests, and platform metadata.
- `GenerationAttempt` records resolved configuration, events, calls, usage, timing, stop reason, and
  capture completeness.
- `VerificationReport` contains named check results and supporting evidence rather than a single
  Boolean or a parsed log.
- `StoredAttempt` identifies content and tree digests.

Production uses an `InstructorPersistenceSink` for exercise versioning, repository commits,
synchronization, cancellation, and undo. Benchmark execution uses a `BenchmarkArtifactSink` that
does not change a live exercise and retains every finished workspace it can capture.

## Benchmark API

The benchmark API must be disabled by default and explicitly authorized. Its normative wire
contract is [`adapters/artemis/benchmark-api.openapi.yaml`](../adapters/artemis/benchmark-api.openapi.yaml).

Generation and verification runs require:

- a caller-supplied idempotency key and durable run state;
- ordered events and recovery after uncertain starts;
- requested and actual approach, model, seed, and model settings;
- provider request IDs and reported token usage;
- exact Artemis, approach, prompt, container image, toolchain, suite, and verifier versions;
- typed failures and `complete`, `partial`, or `none` artifact capture;
- separate public and restricted evidence; and
- size-limited archives that cannot write outside their destination.

A command-line implementation of the same API can run in a fixed container environment. Other
systems continue to use the benchmark's JSON file protocol.

## Approach comparisons

An approach is a named, versioned generation strategy rather than an unnamed collection of request
settings. Every attempt records the approach that actually ran.

When a study removes or changes one part of an approach, the starter material, model profile,
target image, final evaluator, and resource limits stay fixed unless they are the declared change.
Hyperion's own checking, repair, acceptance, and abstention behavior are part of the system being
compared. Feedback from the independent evaluator must not enter Hyperion's repair loop.

## Target verification

The Artemis target adapter owns:

- statement, template, solution, and test role validation;
- Java, Maven, Ares, package, and workspace rules;
- invocation of the shared Artemis verifier;
- structured build, test, task-binding, and gate results; and
- normalized evidence returned to the benchmark.

Any generation approach can submit the same candidate-exercise format to this verifier.
