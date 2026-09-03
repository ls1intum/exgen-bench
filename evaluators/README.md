# Evaluators

Evaluators inspect the same immutable candidate through
[evaluation protocol v1](../docs/PROCESS-EVALUATORS.md). Each evaluator is a versioned,
digest-pinned process with its own append-only journal.

| Evaluator                                   | Measures                                                            | Additional input        |
| ------------------------------------------- | ------------------------------------------------------------------- | ----------------------- |
| [`java-oracle`](java-oracle/SUITE.md)       | whether the solution passes every test and the template passes none | build execution         |
| [`java-static`](java-static/SUITE.md)       | concept fidelity and complexity fit                                 | construct specification |
| [`java-reference`](java-reference/SUITE.md) | similarity to a reference exercise                                  | reference set           |
| [`consistency`](consistency/SUITE.md)       | whether the statement describes the artifacts                       | none                    |

[`promise-traceability`](promise-traceability/README.md) is study-specific and is documented
separately. Exactly one evaluator is authoritative for `strict_success`; release creation requires
that choice when several evaluators are present.

## Java build profiles

`java-oracle` defines the gate independently of where builds run. Its profiles have different trust
properties:

| Profile     | Purpose                                                                 | Trust boundary                                             |
| ----------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| fixture     | contract tests only; replays recorded outcomes and measures nothing new | no build execution                                         |
| Maven host  | local development for Maven exercises                                   | candidate code and build scripts run as the evaluator user |
| Gradle host | local development for Gradle exercises                                  | candidate code and build scripts run as the evaluator user |
| LocalCI     | deployment integration when an Artemis instance must perform the build  | the system under test computes the gate                    |

The host and LocalCI profiles are not suitable for a formal study that requires isolated execution.
That requires a separately operated sandbox with a pinned toolchain. LocalCI-specific setup and
threats are documented in [the Artemis integration guide](../docs/ARTEMIS-INTEGRATION.md).

The published `evaluator.yaml` and `evaluator.gradle.yaml` profiles use Maven and Gradle on the host.
Their relative cache paths resolve from the backend configuration directory.

The Maven profile chooses the JDK per artifact: it reads the Java release the bundle's POMs declare
and builds under the matching `java_homes` entry, so a corpus spanning releases is not built under
one ambient `JAVA_HOME`, and the JDK that ran is the one the attested toolchain names. A declared
release `java_homes` does not cover fails as infrastructure rather than downgrading silently. Those
entries are host paths for the platform the shipped profile targets; a host that installs its JDKs
elsewhere overrides them and re-pins. A bundle that declares no release falls back to `java_home`, as
does a configuration that leaves `java_homes` empty — pin `java_home` when the host default differs
from the target platform JDK.

The Maven profile also runs JaCoCo by default, which is where `coverage.statement` and
`coverage.branch` come from. Set `coverage: false` to leave a build uninstrumented; a configuration
whose `arguments` do not run a Maven lifecycle must, because the goals bracket them.

Run `bun run evaluators:pin` after changing an evaluator implementation, suite, backend
configuration, or reference set. CI runs `bun run evaluators:check` and rejects stale identities.

```bash
for e in java-oracle java-static java-reference consistency; do
  bun run cli evaluate process .exgen/runs/<id> \
    --config evaluators/$e/evaluator.yaml \
    --journal .exgen/runs/<id>/evaluations/$e.jsonl
done

bun run cli release create .exgen/runs/<id> \
  --output release --metadata release.json \
  --metric-cards evaluators/metric-cards.json \
  --journal .exgen/runs/<id>/evaluations/java-oracle.jsonl \
  --journal .exgen/runs/<id>/evaluations/java-static.jsonl \
  --journal .exgen/runs/<id>/evaluations/java-reference.jsonl \
  --journal .exgen/runs/<id>/evaluations/consistency.jsonl \
  --authoritative-evaluator java-oracle
```

## Missing and inapplicable measurements

Reference metrics are `not_applicable` without a reference bundle, and concept metrics are
`not_applicable` without a construct specification. Metrics that require sealed tests or mutants
remain `not_applicable` until an isolated backend can combine them with a candidate. Downstream
aggregation keeps `not_applicable` distinct from missing observations.

## Layout

```text
shared/            protocol harness, bundle reader, and Java analysis
java-oracle/       acceptance gate and build profiles
java-static/       construct specification and checker
java-reference/    reference-based similarity
consistency/       cross-artifact consistency checks
fixtures/          synthetic candidates and expected outcomes
metric-cards.json  metric definitions and limitations
```

`shared/java/` provides a Java lexer and brace-level structure recovery, not a type-resolving parser.
Its results are syntactic approximations; the source headers document the known limits.

The synthetic fixture corpus exercises the evaluator contracts in
`tests/evaluator-fixtures.test.ts`. Recorded fixture outcomes are assertions, not evidence that a
live build profile works; backend-specific tests establish that separately.
