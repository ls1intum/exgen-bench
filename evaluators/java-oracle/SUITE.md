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
| `coverage.statement`, `coverage.branch` | proportion | secondary, never a gate |
| `mutation.score` | proportion | reserved; `not_applicable` until the container backend (WP2c) |

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

## Attestation gaps

Artemis attests neither its own revision, nor the build-agent image, nor the build-script revision.
The backend records all three as `null` with an explicit `unattested` list rather than omitting the
fields. **Two runs months apart are not comparable while these are null, and nothing in the pipeline
can detect that.** Closing the gap is Artemis product work.

## Status

Development suite. Verified against the recorded fixture corpus only. Live verification against a
deployment is WP8 and needs input I1; the repository-write, build-trigger and result-polling
endpoints are unverified and overridable in configuration until then.

The host execution backend has separate Maven and Gradle profiles. The Gradle profile runs an
Artemis-style test repository with the template or solution mounted below `assignment/` and reads
the JUnit XML under `build/test-results/test`. Host profiles execute candidate build scripts with the
evaluator user's permissions and are development-only; a formal run requires the isolated container
backend and a pinned toolchain.
