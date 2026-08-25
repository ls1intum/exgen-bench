# Java oracle

The Java oracle accepts an exercise only when its reference solution passes every test and its
template passes none. The gate semantics do not depend on the build profile.

| Metric                                                   | Type       | Role                                                  |
| -------------------------------------------------------- | ---------- | ----------------------------------------------------- |
| `build.template_compiles`, `build.solution_compiles`     | boolean    | prerequisite                                          |
| `tests.executable`                                       | boolean    | prerequisite                                          |
| `tests.count`                                            | count      | denominator                                           |
| `oracle.solution_pass_rate`, `oracle.template_pass_rate` | proportion | gate inputs                                           |
| `oracle.satisfied`                                       | boolean    | authoritative gate                                    |
| `coverage.statement`, `coverage.branch`                  | proportion | secondary                                             |
| `mutation.score`                                         | proportion | unavailable without isolated access to sealed mutants |

Coverage never changes `strict_success`. Infrastructure failures such as timeouts, unavailable
services, and evaluator crashes produce `infra_failure`, not a quality verdict.

The available build profiles and their trust boundaries are defined in the
[evaluator overview](../README.md#java-build-profiles). Host profiles are useful for development but
execute candidate build scripts with the evaluator user's permissions. LocalCI is an optional
deployment integration with different independence and attestation limits; those limits belong to
the [Artemis integration guide](../../docs/ARTEMIS-INTEGRATION.md).
