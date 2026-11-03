# java-oracle development suite

Decides the benchmark's acceptance gate: the reference solution must pass every test and the
template must pass none.

## What it measures

Metric version 2. Version 1 values are not comparable: version 2 adds the lane, mutation and bypass
metrics and computes `mutation.score` where version 1 reported it as reserved.

| Metric                                                         | Type       | Role                                                           |
| -------------------------------------------------------------- | ---------- | -------------------------------------------------------------- |
| `build.template_compiles`, `build.solution_compiles`           | boolean    | prerequisite                                                   |
| `tests.executable`                                             | boolean    | prerequisite                                                   |
| `tests.count`                                                  | count      | denominator                                                    |
| `oracle.solution_pass_rate`, `oracle.template_pass_rate`       | proportion | gate inputs                                                    |
| `oracle.satisfied`                                             | boolean    | **the only metric that decides `strict_success`**              |
| `oracle.gradable_satisfied`                                    | boolean    | lane-aware verdict (#57); reported, never a gate               |
| `oracle.template_pass_rate_{gradable,structural,preservation}` | proportion | the template pass rate per lane                                |
| `oracle.output_only_bypass`                                    | boolean    | exploratory; Gradle profile only — see below                   |
| `coverage.statement`, `coverage.branch`                        | proportion | secondary, never a gate; Maven and Gradle profiles — see below |
| `mutation.score`                                               | proportion | secondary, never a gate; Gradle profile only — see below       |
| `mutation.covered_survivors`                                   | count      | exploratory; Gradle profile only                               |

Both coverage dimensions come from JaCoCo, which the Maven profile runs by default around the suite
it is executing anyway, and which the Gradle profile adds through an init script while its source
analysis is enabled (`analysis: true`, the default). Both are measured on the solution build, which is
the construct the metric cards name. The `localci` profile reports neither, because Artemis removed
test-wise coverage support (ls1intum/Artemis#9993) and no aggregate coverage survives on a result.
There the metrics are `not_applicable` for every case rather than absent, because a metric that
silently disappears is worse than one that says why it has no value.

Coverage is a secondary score and is never an acceptance gate. Folding a coverage threshold into
acceptance would collapse H1's threshold hypotheses and the primary success rate into one number.

## Independence

This suite's `localci` backend computes the acceptance gate **inside the system under test**
(decision D1, evaluation-completion plan §3). The independence requirement is waived, not met. The
consequences are recorded in `docs/ARTEMIS-INTEGRATION.md § Deviation` and belong in the paper's
threats section, not a footnote. The container backend (WP2c) restores independence as a
configuration change plus a re-run.

Three rules survive the waiver and are enforced in code:

1. Sealed suite assets — hidden tests, reference solutions, mutants — never enter Artemis. Only
   content the candidate itself produced is pushed. This is why the `localci` profile reports no
   mutation score and differential testing waits for the container backend.
2. A timeout, an unreachable deployment or an agent failure maps to `infra_failure` and never to a
   quality verdict.
3. The evaluation course must differ from every generation course, so a generation run cannot
   observe evaluation state. The configuration schema enforces this from the declared course IDs.

Rule 2 rests on matching Artemis's own build-log text (`config.infrastructure_build_failures`):
`BuildStatus.TIMEOUT` exists, but only the admin build-queue endpoints expose it, and this evaluator
should not need administrator rights to tell a timeout from a compile error. That text is Artemis's
wording, not a contract it owes this evaluator, so the signatures are configuration, like `endpoints`,
rather than fixed in source — a deployment on a revision that reworded a message overrides the list,
and the override enters this evaluator's configuration digest rather than silently changing what every
deployment measures. The shipped default was exercised against a live deployment
(`docs/WP8-M2-LIVE.md` §6.5, §9) and is pinned to Artemis PR #13156.

## Attestation

The `localci` backend reads the exercise's own `buildConfig` and records what the deployment actually
reported. Nothing is inferred from a default or a constant: a field the deployment did not report
stays `null` and is named in `unattested`.

| Field                   | Source                                                                    | State                                            |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| `build_agent_image`     | `buildConfig.buildPlanConfiguration.dockerImage`                          | attested                                         |
| `build_phase_scripts`   | `buildConfig.buildPlanConfiguration.phases[]` — name and script, verbatim | attested                                         |
| `build_branch`          | `buildConfig.branch`                                                      | attested                                         |
| `build_script_revision` | `sha256:` over the exact build-plan configuration string                  | attested, as a **content digest**                |
| `artemis_revision`      | —                                                                         | **unattested**: no endpoint used here reports it |

`build_script_revision` is a digest of the script Artemis reported, not an upstream VCS revision, and
must not be read as one. It gives attestation the property it actually needs — two runs whose build
scripts differ get different values — without claiming a version the deployment never supplied.

**The remaining gap still matters.** While `artemis_revision` is null, two runs months apart can
differ in the server that built them and nothing in the pipeline detects it. Closing that is Artemis
product work. The `fixture` backend attests nothing at all and names every field in `unattested`,
because a recording is an assertion about a build, not an observation of one.

## Status

Development suite. Verdicts are verified against the recorded fixture corpus, and the Artemis
result-to-metric mapping is verified against raw payload recordings
(`tests/evaluator-localci-mapping.test.ts`). Both are offline contracts: they establish that the
evaluator is self-consistent, not that the endpoints are right.

Live verification against a deployment is WP8's M2 and needs input I1. Endpoint status:

- **Used by the generation adapter against a live deployment**, so shape-verified: `authenticate`,
  `list_course_exercises`, `create_exercise`, `delete_exercise`.
- **Unverified, and the first thing M2 reconciles**: `write_repository_file`, `commit_repository`,
  `write_test_repository_file`, `commit_test_repository`, `trigger_builds`,
  `exercise_with_participations`, `participation_results`.

Every endpoint is overridable and `endpoints` is inside the configuration digest, so correcting one
produces a new evaluator identity rather than a silent change in what was measured.

## Gradle source measurements

The Gradle profile collects JaCoCo 0.8.14 line/branch reports from the solution build. Its optional
source analysis also keeps line-level counters for the survey's changed-code scope and performs a
compile-only raw-type/unchecked audit in a separate source copy, with standard suppression
annotations disabled. The original tests run on original source. Set `analysis: false` to disable
these additional measurements, and `mutation: false` to skip the mutation and bypass passes below.
Builds whose job sets `analysis: false`, such as the survey builder's mutant builds, skip all of them.
Missing reports remain unmeasured, never zero coverage. Compiler diagnostics are observations, not
acceptance gates.

## Test lanes

An Artemis candidate carries the test catalog of the exercise version it was saved as
(`extensions.artemis.evidence_path` in `response.json`, `exact_version.programmingData.testCases`).
Each executed test falls into one lane by its catalog entry:

- **structural**: type `STRUCTURAL`; signature checks the template's stubs may already satisfy;
- **preservation**: any other type with weight 0; checks of given code that pass on both
  repositories by design;
- **gradable**: any other type with weight above 0.

`oracle.gradable_satisfied` holds when the solution passes every test and the template passes no
gradable test, the rule of evaluation design v2. `oracle.satisfied` keeps the stricter version 1 rule
and stays the gate. The lane metrics fail closed: a candidate without a catalog, a catalog entry
without type or weight, or an executed test the catalog does not list makes every lane metric
`not_applicable` rather than guessing a lane. A lane is only as good as the generator's own weights:
a gradable test it marked with weight 0 is read as preservation.

## Mutation analysis

The Gradle profile runs PIT (`mutation.ts` pins the versions; DEFAULTS mutators) once both
submissions build and the solution passes every test. It mutates only the classes the solution adds
or changes (`tools/kit/changes.ts`), and runs all test classes against them.

PIT cannot run under the Ares 2 Java agent, so it runs in a separate copy of the solution build whose
`build.gradle` has exactly three hooks changed: the `jvmArgumentProviders.add(aresJvmArguments)`
block and the `io.freefair.aspectj.post-compile-weaving` plugin are removed, and the
`aspect "de.tum.cit.ase:ares"` dependency becomes `compileOnly`. The aspect path is also on the
submission's compile classpath, and exercises whose students write JUnit tests in their own sources
compile against the JUnit it brings. Ares stays a test dependency, so `@Policy` and the other annotations compile and do
nothing. The graded builds are never patched. A build whose Ares hooks have another shape is
refused, and tests on Ares 1 (`de.tum.in.test.api`) are `not_applicable`, because Ares 1 installs
its security manager from the test annotations and denies PIT's minion. The PIT plugin is applied
from an init script, so the candidate's plugin block is untouched. The script names the test classes
explicitly; the plugin otherwise searches for tests among the mutated classes and finds none.

`mutation.score` counts KILLED, TIMED_OUT and MEMORY_ERROR mutants as detected, over every mutant of
the changed classes except NON_VIABLE and RUN_ERROR. A NO_COVERAGE mutant counts as surviving,
because untested code a student writes is the gap the metric measures. The evidence lists the count
per status and the survivors with class, method, line, mutator and whether a test covered them.
`mutation.covered_survivors` counts the SURVIVED mutants. A PIT run that leaves no complete report
is `infra_failure` for these two metrics only.

The Maven profile does not run PIT: the JUnit 5 plugin must be a plugin dependency in the `pom.xml`,
and that profile never edits the candidate's build. No `-Dline.separator` argument is passed: PIT
trims the newline from a JVM argument, which leaves an empty line separator and turns output tests
red. The Linux build images default to `\n` anyway.

## Output-only bypass probe

When a class the solution changes declares `public static void main` and the tests call that
`main`, the Ares-free copy also runs the solution's `main` once, with no arguments, empty standard
input and a 20 s limit, and records its standard output. The graded build then reruns with only that
`main`'s body replaced by a print of the recorded output; every other member stays as in the
solution. `oracle.output_only_bypass` is true, which is bad, when this passes every gradable test.
It is `not_applicable` when no tested `main` changes, when the solution reads `System.in`, when
`main` fails or runs out of time, when its output exceeds 16 KiB, or when the lanes are unknown.

## Isolation

The extra passes execute candidate code like the graded builds do. The host Gradle profile gives
them no more isolation than those builds. A campaign-local wrapper that runs each Gradle command in
an offline container must also carry PIT and its dependencies in its Gradle cache, and copy back
`build/reports/pitest/mutations.xml` and `build/exgen-main/` besides the JUnit reports; without them
the two passes report `infra_failure` and `not_applicable` instead of a value.
