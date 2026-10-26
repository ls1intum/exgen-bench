# Tier 1 deterministic metrics

Measures a candidate exercise by program analysis, with no model and no reference exercise. Every
evaluator here is reproducible from the candidate and its listed inputs, and the execution oracle
additionally runs the candidate's build.

| Evaluator | Default | Measures | Additional input |
| --- | --- | --- | --- |
| [`java-oracle`](java-oracle/SUITE.md) | yes | whether the solution passes every test and the template passes none | build execution |
| [`java-static`](java-static/SUITE.md) | yes | concept fidelity and complexity fit | construct specification |
| [`consistency`](consistency/SUITE.md) | yes | whether the statement describes the artifacts | none |
| [`promise-traceability`](promise-traceability/README.md) | yes | whether the tests witness what the statement promises | none |
| `java-oracle-gradle` | no | the oracle on the host Gradle toolchain | build execution |
| `java-oracle-fixture` | no | the oracle replaying recorded outcomes; contract tests only | recordings |
| `java-oracle-localci` | no | the oracle built by an Artemis LocalCI deployment; template configuration | an Artemis instance |

```sh
bun run cli evaluate tool tier1-deterministic .exgen/runs/<id>
bun run cli evaluate tool tier1-deterministic .exgen/runs/<id> --evaluator java-oracle-gradle
```

`java-oracle` is the evaluator a study normally declares authoritative for `strict_success`.
`promise-traceability` reports measurability, not quality; see its README before reporting it. Its
model-assisted counterpart lives in [`tier1-model-assisted`](../tier1-model-assisted/README.md).

Metric cards: [`metric-cards.json`](metric-cards.json) for the oracle, static and consistency
families, and [`promise-traceability/metric-cards.json`](promise-traceability/metric-cards.json).

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
threats are documented in [the Artemis integration guide](../../docs/ARTEMIS-INTEGRATION.md).

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
