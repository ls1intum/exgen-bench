# Artemis integration design

## Decision

Artemis production authoring and benchmark execution should use the same generation and
verification cores with different persistence policies:

```text
Production
brief → generation approach → candidate → canonical verifier → live exercise persistence

Benchmark
brief → generation approach → candidate → canonical verifier → immutable attempt bundle
                                      └→ independent evaluators
```

The benchmark does not copy Artemis verification logic or use its live-exercise persistence API as
a research ledger. A pinned Artemis revision may provide the target format and verifier without
determining how exercises are generated.

## Artemis boundaries

The Artemis refactoring should expose three dependency-light boundaries:

```java
interface ExerciseGenerationApproach {
    ApproachDescriptor descriptor();
    GenerationAttempt generate(GenerationInput input, GenerationObserver observer);
}

interface CandidateVerifier {
    VerificationReport verify(CandidateBundle candidate, VerificationProfile profile);
}

interface AttemptSink {
    StoredAttempt store(
        GenerationAttempt attempt,
        CandidateBundle candidate,
        VerificationReport report
    );
}
```

Their values have distinct responsibilities:

- `GenerationInput` carries the caller's attempt ID, brief, scaffold, target, approach, and budget.
- `CandidateBundle` contains the statement, template, solution, tests, and platform metadata.
- `GenerationAttempt` records resolved configuration, events, calls, usage, timing, stop reason, and
  capture completeness.
- `VerificationReport` contains typed gates and evidence rather than a Boolean or parsed log.
- `StoredAttempt` identifies immutable content and tree digests.

Production uses an `InstructorPersistenceSink` for exercise versioning, repository commits,
synchronization, cancellation, and undo. Benchmark execution uses a `BenchmarkArtifactSink` that
does not mutate a live exercise and retains every terminal workspace it can capture.

## Benchmark API

The benchmark API must be disabled by default and explicitly authorized. Its normative wire
contract is [`adapters/artemis/benchmark-api.openapi.yaml`](../adapters/artemis/benchmark-api.openapi.yaml).

Generation and verification runs require:

- a caller-supplied idempotency key and durable run state;
- ordered events and recovery after uncertain starts;
- requested and effective approach, model, seed, and decoding configuration;
- provider request IDs and reported token usage;
- exact Artemis, approach, prompt, image, toolchain, suite, and verifier identities;
- typed failures and `complete`, `partial`, or `none` artifact capture;
- separate public and restricted evidence; and
- bounded, containment-checked archives.

A headless implementation of the same contract can run in a pinned OCI environment. Other systems
continue to use the benchmark's transport-neutral file protocol.

## Approach comparisons

Approaches are immutable named descriptors, not sets of ad hoc request flags. Every attempt records
the resolved descriptor.

Ablations share the same scaffold, model profile, target image, final evaluator, and nominal budget
except for their declared treatment factors. Hyperion's own verification, repair, acceptance, and
abstention are part of the treatment. Independent evaluator feedback must not enter its repair loop.

## Target verification

The Artemis target adapter owns:

- statement, template, solution, and test role validation;
- Java, Maven, Ares, package, and workspace rules;
- canonical verifier invocation;
- structured build, test, task-binding, and gate results; and
- normalized evidence returned to the benchmark.

Any generation approach can submit the same candidate contract to this verifier.
