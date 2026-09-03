# java-oracle development suite

Decides the benchmark's acceptance gate: the reference solution must pass every test and the
template must pass none.

## What it measures

| Metric | Type | Role |
| --- | --- | --- |
| `build.template_compiles`, `build.solution_compiles` | boolean | prerequisite |
| `tests.executable` | boolean | prerequisite |
| `tests.count` | count | denominator |
| `oracle.solution_pass_rate`, `oracle.template_pass_rate` | proportion | gate inputs |
| `oracle.satisfied` | boolean | **the only metric that decides `strict_success`** |
| `coverage.statement` | proportion | secondary, never a gate; Maven profile only — see below |
| `coverage.branch` | proportion | secondary, never a gate; Maven profile only — see below |
| `mutation.score` | proportion | reserved; `not_applicable` until the container backend (WP2c) |

Both coverage dimensions come from JaCoCo, which the Maven profile runs by default around the suite
it is executing anyway, and both are measured on the solution build, which is the construct the
metric cards name. The other profiles report neither: `localci` because Artemis removed test-wise
coverage support (ls1intum/Artemis#9993) and no aggregate coverage survives on a result, `gradle`
because its builds are not instrumented. Under those profiles the metrics are `not_applicable` for
every case rather than absent, because a metric that silently disappears is worse than one that says
why it has no value.

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
   content the candidate itself produced is pushed. This is why mutation score and differential
   testing wait for the container backend.
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

| Field | Source | State |
| --- | --- | --- |
| `build_agent_image` | `buildConfig.buildPlanConfiguration.dockerImage` | attested |
| `build_phase_scripts` | `buildConfig.buildPlanConfiguration.phases[]` — name and script, verbatim | attested |
| `build_branch` | `buildConfig.branch` | attested |
| `build_script_revision` | `sha256:` over the exact build-plan configuration string | attested, as a **content digest** |
| `artemis_revision` | — | **unattested**: no endpoint used here reports it |

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
