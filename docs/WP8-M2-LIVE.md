# WP8 M2: the java-oracle against a live Artemis LocalCI deployment

M2 asks one question: does the live Artemis LocalCI backend reach the same verdicts as the
reproducible offline fixture backend, over the same bundles? This document records how the
deployment was stood up, what its API actually answers, which of those answers the evaluator was
written against incorrectly, and what a local instance still cannot settle.

§1-§5 are the reconciliation: the deployment, and every endpoint shape as first observed. §6-§9 are
the corrections and the result. The §4 tables deliberately keep the *original* wrong shapes rather
than being rewritten to the fixed ones — a record of what a deployment answers is only useful if it
still shows what was believed before.

---

## 1. How Artemis was stood up

PR [ls1intum/Artemis#13156](https://github.com/ls1intum/Artemis/pull/13156) was checked out into a
sibling directory of the exgen-bench working tree, so nothing about the deployment can reach this
branch.

| | |
|---|---|
| Checkout | `/home/devbox/workspace/artemis-m2/Artemis` (outside the exgen-bench tree) |
| PR head | `6ec787d5b6` — "Programming exercises: restore develop's problem-statement test contract" |
| Merge base with `develop` | `727336fed7` |
| Compose file | `docker/artemis-dev-local-vc-local-ci-mysql.yml` + a local `docker/m2-override.yml` |
| Spring profiles | `artemis,scheduling,localci,localvc,buildagent,core,dev,docker,sharing` |
| Database | MySQL 9.7.2 |
| Runtime | eclipse-temurin 25.0.3_9, Spring Boot 4.1.0 |
| Ports | 8080 app, 3306 MySQL, 5005 JDWP; LocalVC advertises repositories at `http://localhost:8000/git/...` |
| Build agent image | `ls1tum/artemis-maven-template:java17-25` (pre-pulled) |
| Default build phases | `compile` → `mvn -B clean compile`, `test` → `mvn -B test` |
| Time to readiness | ~110 s to `{"status":"UP"}` on `/management/health/readiness` |

The image is built from source rather than pulled: no published tag corresponds to a PR branch.

```bash
docker compose --env-file .env \
  -f docker/artemis-dev-local-vc-local-ci-mysql.yml -f docker/m2-override.yml build artemis-app
docker compose --env-file .env \
  -f docker/artemis-dev-local-vc-local-ci-mysql.yml -f docker/m2-override.yml up -d
```

Two things about this setup are not in the upstream documentation and cost time:

- **`.env` lives at the repository root, not in `docker/`.** Every compose file there interpolates
  `${MYSQL_IMAGE}` and friends from it with no fallback, by design. Running `docker compose` from
  inside `docker/` fails with `service "mysql" has neither an image nor a build context specified`.
  The `--env-file .env` invocation from the repository root is required.
- **The docker group id is hardcoded.** `artemis-dev-local-vc-local-ci-mysql.yml` sets
  `group_add: ["999"]` so the container can use the mounted docker socket, which is what lets LocalCI
  start build containers at all. This host's docker GID is **988**. The override file corrects it;
  without it the stack comes up healthy and builds simply never run.

`docker/m2-override.yml` (local to the Artemis checkout, not committed here):

```yaml
services:
    artemis-app:
        group_add:
            - "988"          # this host's docker GID; upstream hardcodes 999
        environment:
            _JAVA_OPTIONS: ""  # drop the JDWP agent the dev env file enables
```

### Bootstrap

The seeded internal admin is `artemis_admin`, documented in
`src/main/resources/config/application-artemis.yml` and restated in `docker/artemis/config/prod.env`;
`ARTEMIS_USERMANAGEMENT_USEEXTERNAL=false` in the dev env file is what makes it exist.

Logged in as that admin, the bootstrap creates:

- a dedicated **EVALUATION course, id 1** (`exgeneval`). This throwaway instance hosts no generation
  course at all, so `generation_course_ids` is empty and the disjointness the schema enforces is
  trivially satisfied.
- an evaluation account holding instructor rights on that course, created via
  `POST /api/account/admin/users` and `POST /api/course/courses/{courseId}/instructors/{login}`.

One non-obvious requirement: the account payload **must** set `internal: true`.
`UserCreationService.createUser` only hashes and stores a password
`if (userDTO.isInternal())`, and `internal` is a primitive `boolean` defaulting to `false`. Without
it the account is created and activated but has no password, and every authentication returns 401.

The account's password was chosen for this deployment and lives only in the environment variables
named below. It appears in no file in this repository, no configuration, no log and no report.

### Confirmation that LocalCI actually builds

Not assumed — observed. Artemis auto-triggers template and solution builds on exercise creation;
build containers ran and results came back carrying a real `completionDate`. The execution path is
live, which is what makes the endpoint findings below meaningful rather than theoretical.

---

## 2. Reproducing the M2 run

```bash
ARTEMIS_EVALUATION_USERNAME=... ARTEMIS_EVALUATION_PASSWORD=... \
  bun run scripts/verify-m2-oracle.ts <localci-config.yaml> correct-exercise
```

The configuration file is kept outside this repository because it names a deployment rather than a
committed artifact. It is a filled-in copy of `evaluators/java-oracle/config.localci.example.yaml`
with `base_url: http://localhost:8080`, `evaluation_course_id: 1`, `generation_course_ids: []`, and
the two credential **variable names** — never their values.

Note that the fixture corpus has no `encapsulation` case. The committed cases are
`correct-exercise`, `non-terminating-test`, `reference-pair`, `solution-does-not-compile`,
`solution-fails-tests`, `statement-contradicts-tests`, `template-already-passes` and
`test-reads-forbidden-file`. Phase A used `correct-exercise`.

---

## 3. Result of the first live run

`correct-exercise` ran end to end. The live side returned **`infra_failed` /
`infrastructure.unavailable`**, so all 13 comparisons diverged — the seven verdict metrics reported
`absent`, and coverage and mutation reported `absent` rather than `not_applicable`.

**No case reached a quality verdict, and that is the correct outcome.** `create_exercise` returns
HTTP 400, so the backend never obtains an exercise to build. The invariant that every HTTP, timeout
and agent failure raises `InfrastructureError` held: nothing turned a broken request into a
statement about the exercise.

---

## 4. Endpoint reconciliation

Eleven endpoints, of which four were previously verified against a live deployment through the
generation adapter and seven were written against Artemis's REST conventions and never exercised.

### Correct as configured (5)

| Endpoint | Observed |
|---|---|
| `authenticate` | `POST /api/core/public/authenticate` → 200, sets the `jwt` cookie |
| `list_course_exercises` | `GET /api/programming/courses/{courseId}/programming-exercises` → 200, JSON array |
| `commit_repository` | `POST /api/programming/repository/{participationId}/commit` → 200 |
| `commit_test_repository` | `POST /api/programming/test-repository/{exerciseId}/commit` → 200 |
| `delete_exercise` | `DELETE /api/programming/programming-exercises/{exerciseId}?...` → 200 |

### Wrong (6)

#### 4.1 `create_exercise` — four defects, all in the request

Each fix exposed the next error, so the four are genuinely independent:

| Request | Response |
|---|---|
| the payload `localci-backend.ts` sends today | `400 "Failed to read request"` |
| `+ "type": "programming"` | `400 noParticipationModeAllowed` |
| `+ allowOnlineEditor: true` | `400 packagenameInvalid` |
| `+ packageName`, `projectType`, `buildConfig`, `maxPoints`, … with `emptyRepositories=true` | `400 hyperionDisabled` |
| the same payload with `emptyRepositories=false` | **201 Created** |

1. **Missing polymorphic discriminator.** `Exercise` is annotated
   `@JsonTypeInfo(use = Id.NAME, property = "type")` with
   `@JsonSubTypes({@Type(value = ProgrammingExercise.class, name = "programming"), ...})`
   (`Exercise.java:81-89`). Without `"type": "programming"` the body fails *deserialization*, before
   any validator runs — which is why the error is a bare "Failed to read request" rather than a
   named validation key.
2. **No participation mode.** `validateProgrammingSettings()` (`ProgrammingExercise.java:677`)
   rejects a payload unless one of `allowOnlineEditor`, `allowOfflineIde` or `allowOnlineIde` is
   true. The current payload sets `allowOfflineIde: false` and nothing else.
3. **Missing `projectType` and `packageName`.** `validateProjectType` and `validatePackageName`
   (`ProgrammingExerciseValidationService.java:143-144`) require both for Java. Under LocalCI the
   allowed Java project types are `PLAIN_GRADLE, GRADLE_GRADLE, PLAIN_MAVEN, MAVEN_MAVEN,
   MAVEN_BLACKBOX`; `PLAIN_MAVEN` matches the `artemis-java-maven` target profile. `buildConfig`
   must also be present — the validator dereferences it unconditionally.
4. **`emptyRepositories=true` is gated on Hyperion on this branch.** This is PR-specific and the
   most consequential finding. `createProgrammingExercise` treats the flag as "this creation is an
   AI generation" and calls `validateAiGenerationPreconditions`
   (`ProgrammingExerciseCreationUpdateService.java:177-178`), which throws `hyperionDisabled` unless
   the Hyperion module is on. Turning Hyperion on requires Spring AI, i.e. an LLM provider — which
   the model-free oracle must not depend on. The model-free path is therefore
   `emptyRepositories=false`, creating the exercise with Artemis's seeded Java template and
   overwriting those files with the bundle's.

   _Consequence to settle in Phase B:_ with `emptyRepositories=false` the repositories are not empty
   before the bundle is pushed, so any seeded file the bundle does not overwrite survives into the
   build.

#### 4.2 `write_repository_file` and `write_test_repository_file` — wrong method and wrong body

The configured `PUT .../file?file={path}` with a JSON `{content}` body returns **405 Method Not
Allowed** for both the participation and the test repository. No `PUT .../file` route exists. Two
real endpoints do (`RepositoryProgrammingExerciseParticipationResource.java:338,383` and the
matching pair in `TestRepositoryResource.java`):

- `POST .../file?file={path}` — content is the **raw request body**, not JSON. → 200. This is the
  create path.
- `PUT .../files?commit={bool}` — body `[{fileName, fileContent}]`. → 200, but for a file that does
  not yet exist it answers `{"probe2.txt":"File could not be found."}`: it updates, it does not
  create.

Neither is reachable by changing a URL template. `call()` always `JSON.stringify`s the body and
sends `Content-Type: application/json`, so both the raw-body form and the batched-list form require
a code change.

#### 4.3 `trigger_builds` — answers 200 and builds nothing

`POST /api/programming/programming-exercises/{exerciseId}/trigger-instructor-build-all` returns 200,
but `triggerInstructorBuildForExercise` only loads **student** participations
(`ProgrammingTriggerService.java:117`), and an evaluation exercise has none. The call is a no-op for
template and solution. A silent success is a worse failure mode than an error here.

The correct call is per participation:
`POST /api/programming/participations/{participationId}/trigger-build?submissionType=INSTRUCTOR`
→ 200, documented in the handler as supporting template and solution participations explicitly.
Since it is per participation rather than per exercise, it changes the shape of the call site.

#### 4.4 `exercise_with_participations` — right path, no `buildConfig`

Returns 200 with correct `templateParticipation.id` and `solutionParticipation.id`, but the response
carries **no `buildConfig` at all**: it is a `LAZY @OneToOne` (`ProgrammingExercise.java:147-150`)
that `loadProgrammingExercise` never fetches. `attestation()` therefore degrades to fully
unattested — image, script revision, phases and branch all null. That degradation is clean and
honest, but it discards evidence the deployment is willing to give.

`GET /api/programming/programming-exercises/{exerciseId}` returns **both** the two participations
and a populated `buildConfig`:

```json
{"branch": "main", "timeoutSeconds": 0,
 "buildPlanConfiguration": "{\"phases\":[{\"name\":\"compile\",\"script\":\"mvn -B clean compile\",...},
   {\"name\":\"test\",\"script\":\"mvn -B test\",...}],
   \"dockerImage\":\"ls1tum/artemis-maven-template:java17-25\"}"}
```

`buildPlanConfiguration` arrives as a JSON *string*, exactly the shape `attestation()` already
parses. This one is a pure configuration override and it restores the attestation path.

#### 4.5 `participation_results` — the endpoint does not exist

`GET /api/exercise/participations/{participationId}/results?withSubmissions=true` → **404, "No
static resource"**. `ParticipationResource` is mapped at `api/exercise/` and declares no such route;
`ResultResource` sits at `api/assessment/` and also has none
(`/api/assessment/participations/{id}/results` → 404 as well).

Results are reachable only as **`participation.submissions[].results[]`** from
`with-template-and-solution-participation?withSubmissionResults=true` — a different URL, a different
nesting, and exercise-scoped rather than participation-scoped. Observed result keys:

```
assessmentType, codeIssueCount, completionDate, exerciseId, id,
passedTestCaseCount, rated, score, successful, testCaseCount
```

There is **no `feedbacks` field**. Feedbacks require a second call,
`GET /api/assessment/participations/{participationId}/results/{resultId}/details` → `Feedback[]`.
The backend's `awaitResult` expects a flat `Result[]` with inline `feedbacks` at a participation
URL; that shape exists nowhere in Artemis. `toSubmissionBuild` derives `test_cases`, `tests_executed`
and both pass rates from those feedbacks, so this is the endpoint the verdict actually depends on.

---

## 5. Coverage is not available from any current Artemis

`coverageFrom()` reads `coverageFileReportsByTestCaseName` off the result. That field exists nowhere
in this codebase: Artemis **removed testwise coverage support entirely** in commit `22d38a8130`
("Development: Remove testwise coverage support (#9993)").

So `coverage.statement` is permanently `not_applicable` on the live side. Eight of the nine oracle
recordings carried a statement-coverage value, which made them `ok` on the fixture side, so this
diverged on nearly every case.

Confirmed in Phase B that nothing survives in its place: `Result` carries `testCaseCount`,
`passedTestCaseCount` and `codeIssueCount` and no coverage field of any kind, and the string
`coverage` does not occur anywhere in the `assessment`, `programming`, `buildagent` or `localci`
packages.

**Resolution.** Both dimensions are now `not_applicable` on both sides:

- `m2-contract.ts` lists `coverage.statement` **and** `coverage.branch` in `MUST_BE_NOT_APPLICABLE`,
  each with the reason.
- The oracle recordings record `coverage: null`, which is what the live backend now reports.
- `toSubmissionBuild` returns `coverage: null` unconditionally and the dead
  `coverageFileReportsByTestCaseName` reader is gone.

Both metrics stay **declared** in `STATUS_ONLY_METRICS` and in every evaluator configuration. They are
not deleted, because the container backend (WP2c) is expected to measure them and a metric that
disappears from the contract cannot be noticed to have come back.

---

## 6. Corrections applied

Endpoint templates are all overridable and all inside the configuration digest, so a corrected path
is a configuration change by design. Where the deployment's shape could not be expressed as a URL —
a different HTTP method, a non-JSON body, a different number of round trips — `localci-backend.ts`
changed instead. Both kinds are listed, with what was sent before and what is sent now.

### 6.1 Endpoint paths — configuration

| Endpoint | Before | After |
|---|---|---|
| `create_exercise` | `…/setup?emptyRepositories=true` | `…/setup?emptyRepositories=false` |
| `exercise_with_participations` | `…/{id}/with-template-and-solution-participation?withSubmissionResults=true` | `/api/programming/programming-exercises/{exerciseId}` |
| `trigger_builds` → `trigger_build` | `…/programming-exercises/{exerciseId}/trigger-instructor-build-all` | `/api/programming/participations/{participationId}/trigger-build?submissionType=INSTRUCTOR` |
| `participation_results` → `exercise_results` | `/api/exercise/participations/{participationId}/results?withSubmissions=true` | `…/programming-exercises/{exerciseId}/with-template-and-solution-participation?withSubmissionResults=true` |
| `result_details` *(new)* | — | `/api/assessment/participations/{participationId}/results/{resultId}/details` |
| `list_repository_files` *(new)* | — | `/api/programming/repository/{participationId}/files` |
| `delete_repository_file` *(new)* | — | `/api/programming/repository/{participationId}/file?file={path}` |
| `list_test_repository_files` *(new)* | — | `/api/programming/test-repository/{exerciseId}/files` |
| `delete_test_repository_file` *(new)* | — | `/api/programming/test-repository/{exerciseId}/file?file={path}` |

`authenticate`, `list_course_exercises`, `commit_repository`, `commit_test_repository`,
`delete_exercise` and both file-write **paths** were already right and are unchanged.

Two of these are renames rather than edits, because the old name asserted something false:
`trigger_builds` was never plural against this API, and `participation_results` is exercise-scoped,
not participation-scoped. A key that lies about its own scope is worse than a wrong path, because it
survives the next person's reading of the config.

### 6.2 Shapes that no URL could express — code

**Exercise creation payload.** Before, six fields; now the request additionally carries
`type: "programming"` (Artemis deserialises `Exercise` polymorphically and rejects the body outright
without it), `allowOnlineEditor: true` (at least one participation mode is required),
`projectType: "PLAIN_MAVEN"`, `packageName`, `staticCodeAnalysisEnabled`, `maxPoints`,
`assessmentType` and a non-null `buildConfig` (validation dereferences it unconditionally). The
removed `publishBuildPlanUrl` was never read.

**Repository writes.** Before: `PUT …/file?file={path}` with a JSON `{content}` body, one call per
file, which answers **405** — no such route exists. Now: `POST …/file?file={path}` with the file's
content as the **raw** request body. `call()` gained a `RequestBody` discriminated union
(`{json}` / `{raw}`) because it previously always `JSON.stringify`d, which would have written the
envelope into the repository as the file's bytes.

**Repository reconciliation.** New, and required by the switch to `emptyRepositories=false`. Each
repository is listed, every seeded `FILE` deleted, then the bundle written, then committed. Deleting
first is not tidiness: Artemis refuses to create a path that already exists
(`"Expected file to not exist"`), so without it every write over a seeded file would fail. Only
`FILE` entries are deleted — git has no folders, and removing a `FOLDER` entry whose last file is
already gone is an error. This is what makes the verdict a function of the bundle rather than of
Artemis's seeded sorting exercise.

**Result polling.** Before: `GET …/participations/{id}/results` parsed as a flat `Result[]` with
inline `feedbacks`. That endpoint does not exist on any base path, and that shape exists nowhere in
Artemis. Now results are read from the exercise as `participation.submissions[].results[]`, and the
per-test breakdown is fetched per result from the details endpoint. `buildFailed` is read from the
**submission**, not the result. `toSubmissionBuild` accordingly takes a `CompletedBuild`
(`{submission, result, feedbacks}`) instead of a single result object.

**Test-case naming.** Artemis names an automatic feedback's test case in `testCase.testName` when
the exercise's test cases are known, and in `text` when they are not — which is exactly what happens
when the *solution* build failed, because that is the build that establishes them. Reading only the
relation reported the template of `solution-does-not-compile` as running no tests at all, when
Artemis had reported three. The fallback additionally requires an explicit `positive`, so a build
remark that merely carries text stays a diagnostic instead of inflating the suite.

**Which build is this evaluation's build.** The hardest correction, and the one with the worst
failure mode. Artemis builds the template and solution when it *creates* the exercise, against its
own seeded template. Baselining on result ids after the commits was not enough: a seed build can
still be queued when the baseline is taken, so its result does not exist yet and it is admitted as
new. That happened, and the oracle read a verdict computed from Artemis's seeded sorting exercise —
13 feedbacks named `testClass[MergeSort]`, `testBubbleSort` and so on, for a bundle whose suite has
two tests.

The baseline is now the set of **submission ids** taken **before anything is pushed**. A submission
exists as soon as Artemis triggers a build, so excluding it excludes that build whenever it finishes.
The newest accepted result must also be stable across two consecutive polls, so a build triggered by
an intermediate commit is not read as the answer.

**Coverage.** `coverageFrom()` is gone; `toSubmissionBuild` reports `coverage: null`. See §5.

### 6.3 Deployment configuration, not evaluator code

Not an endpoint correction, but it blocked every build and belongs in the record.
`application-localvc.yml` advertises `http://localhost:8000` as the git clone URL — the dev proxy's
address, which nothing serves in the container setup — so the build agent failed to clone with
`connection failed` and no Maven phase ever ran. Corrected in the local compose override with
`ARTEMIS_VERSIONCONTROL_URL=http://artemis-app:8080`.

### 6.4 Fixtures corrected, and why the bundle rather than the recording

Three fixture defects were found by running them, all invisible offline because the recordings
asserted whatever they were authored to assert.

1. **Templates that pass a test.** Five bundles shipped a `return 0;` stub while their suite asserts
   `assertEquals(0, sumEven(new int[]{}))` — a test the stub genuinely passes. Confirmed from the
   deployment's own feedbacks. By the oracle's own gate those bundles were not what they claimed to
   be. The **bundle** was fixed (the stub now throws `UnsupportedOperationException`, the idiomatic
   Artemis template), not the recording: rewriting the recordings would have collapsed
   `correct-exercise` into `template-already-passes` and left the corpus with no positive case.
   `template-already-passes` was deliberately left alone and still passes, which is what keeps the
   distinction the corpus exists to draw.
2. **A failed compile carries no feedbacks.** The recording for `solution-does-not-compile` invented
   two compiler-error feedbacks. Live, a build that fails to compile returns an **empty** feedback
   list; `buildFailed` on the submission is the entire signal, and the compiler's output lives only
   in the build logs. Re-recorded, and the mapping test now asserts no diagnostics rather than some.
3. **A denied file read is a failing test, not a harness abort.** `test-reads-forbidden-file`
   recorded the sandbox aborting the suite (`tests.executable: false`, `tests.count: 0`). Live, the
   sandbox denies the read and reports it as an ordinary failing test: both builds compile, two tests
   run, and the solution passes only the one that does not touch the filesystem. Re-recorded, with
   `expected.json` moved to `quality.threshold_not_met`. The case still does what it exists to do —
   the exercise is rejected — for the reason that actually occurs.

The recorded feedback *text* for the re-recorded cases was captured from the live deployment rather
than written, so the offline corpus now replays messages the deployment really produced.

### 6.5 A LocalCI timeout is not a verdict

The last correction, and the one the guardrail is about. `non-terminating-test` ships a test with no
`@StrictTimeout` that spins forever. The fixture models this as the evaluator's poll loop running to
its deadline because no result ever arrives. That is not what a real Artemis does: LocalCI stops the
build at its own timeout — 240 s here, `artemis.continuous-integration.build-timeout-seconds.max` —
and records a *completed* result. Observed in the build log of both participations:

```
Error while executing build job 491786635684555: null
java.util.concurrent.TimeoutException
Timed out after 240 seconds. This may be due to an infinite loop or inefficient code. …
```

That result is `buildFailed` with no feedbacks and no test cases — **byte for byte the same shape as
a build whose code does not compile**. Mapped naively it reads as `compiled: false`, and the oracle
reports "the solution does not compile" about an exercise whose only fault is that the queue gave up.
An exhausted build agent would have become a quality verdict about the candidate.

So a failed build now has its log read, and a log carrying an infrastructure signature raises
`InfrastructureError` instead of being mapped. Two signatures are matched, both taken from a live
deployment rather than from the source: the timeout above (`evaluator.timeout`) and Artemis's own
"temporary infrastructure issue while preparing the build environment" (`infrastructure.unavailable`).

The log is read **only** for a build that already failed, so a healthy evaluation pays nothing, and
`solution-does-not-compile` — whose log carries `[ERROR] COMPILATION ERROR` and no infrastructure
signature — correctly stays a quality verdict. Both directions are pinned by tests.

The signature is matched against log *text* because there is no better signal available:
`BuildStatus.TIMEOUT` exists in Artemis, but only `AdminBuildJobQueueResource` exposes it, and an
evaluator should not need administrator rights on the deployment it measures to tell a timeout from
a compile error. This is the one correction resting on a string rather than a field, and §9 records
it as such.

## 7. Final implementation digest

The WP8/M2 endpoint corrections changed `localci-backend.ts` and `m2-contract.ts`, so the
java-oracle digest was recomputed (after `bun run format`, with
`bun run evaluators/shared/identity.ts evaluators/java-oracle`) from the pre-WP8 `4b86f845…` to:

```
evaluator.implementation_digest: 7d404cbfe074bbd84e910a02b6fc853060e8777aa7758f848e5654fdd71eeaa1
suite.digest:                    e63168c1c9c7eff88df9b857eca59d4d1fb156dd2e3b0e37330f2a8c5a37c595
```

That value was then superseded when this work was merged onto `main` alongside #20
("Decide the acceptance gate by building the candidate"), which adds `maven-backend.ts` to the
worker's transitive import closure. The digest was recomputed once more over the reconciled tree, so
`evaluators/java-oracle/evaluator.yaml` on this branch carries:

```
evaluator.implementation_digest: 064f30e9d6f17c1d0ef39e439bc58df26a4db4999b56525c08d5bcd105e7b778
suite.digest:                    e63168c1c9c7eff88df9b857eca59d4d1fb156dd2e3b0e37330f2a8c5a37c595
```

The suite digest is unchanged throughout, which is correct: `SUITE.md` and the metric cards did not
change, only the implementation did.

The digest covers the worker's whole transitive import closure, so it moves whenever an imported file
changes — the WP8 endpoint corrections (§6) and the #20 Maven backend both change *what is measured*,
so each must produce a new evaluator identity. A run recorded before either change and one recorded
after are not comparable, and the digest is what says so.

## 8. M2 result per case

`verify-m2-oracle.ts` exits **0** over the whole committed corpus, in one sequential run against the
live deployment:

```
M2: 8 case(s) through the fixture backend and localci at http://localhost:8080

  ok        correct-exercise            (succeeded/true)
  ok        non-terminating-test        (infra_failed/null)
  ok        reference-pair              (succeeded/true)
  ok        solution-does-not-compile   (quality_failed/false)
  ok        solution-fails-tests        (quality_failed/false)
  ok        statement-contradicts-tests (succeeded/true)
  ok        template-already-passes     (quality_failed/false)
  ok        test-reads-forbidden-file   (quality_failed/false)

M2 PASSED: the localci backend and the fixture backend agree on every verdict.
```

| Case | Verdict | What it establishes |
|---|---|---|
| `correct-exercise` | `succeeded` / `true` | The gate is reachable: solution passes 3/3, template 0/3. |
| `non-terminating-test` | `infra_failed` / `null` | A build LocalCI stopped is `evaluator.timeout` on both sides, not a verdict. |
| `reference-pair` | `succeeded` / `true` | A second satisfied exercise, with a differently-named suite. |
| `solution-does-not-compile` | `quality_failed` / `false` | A failed compile is a fact about the candidate, and the template's suite still reads correctly through the `text` feedback spelling. |
| `solution-fails-tests` | `quality_failed` / `false` | A solution that cannot pass its own tests is rejected. |
| `statement-contradicts-tests` | `succeeded` / `true` | The oracle is indifferent to statement/test disagreement — that is the consistency evaluator's job, and M2 confirms the oracle does not accidentally encroach. |
| `template-already-passes` | `quality_failed` / `false` | A template that passes a test is rejected. Left untouched through the corpus repairs, so it is the control that the §6.4 fix did not simply make every template fail. |
| `test-reads-forbidden-file` | `quality_failed` / `false` | A sandbox-denied read is a failing test, and the exercise is rejected because the solution cannot pass it. |

Three of the eight (`succeeded`) carry a positive verdict and five do not, so agreement is not the
degenerate kind where both sides refuse to decide. Only `non-terminating-test` is an infrastructure
failure, and `compareVerdicts` checks that neither side smuggled a score out alongside it.

Comparison rules, as designed: the seven verdict metrics are compared **by value**;
`coverage.statement`, `coverage.branch` and `mutation.score` must be `not_applicable` on both sides.

### Reproducing

```bash
ARTEMIS_EVALUATION_USERNAME=... ARTEMIS_EVALUATION_PASSWORD=... \
  bun run scripts/verify-m2-oracle.ts <localci-config.yaml>
```

Env-var **names** only; the values live nowhere but the environment. Add a case id to run one case.
Budget roughly 25-30 minutes for the full corpus on a single build agent — `non-terminating-test`
alone spends two full 240 s build timeouts by design.

## 9. What a local instance cannot settle

M2 holding here means the two backends agree about these bundles on *this* deployment. The following
are deliberately not settled by that, and a hosted deployment has to answer them separately.

**Attestation values are this instance's, not production's.** The build agent image reported is
`ls1tum/artemis-maven-template:java17-25` — a floating tag with no digest pin, so two runs months
apart can attest the same string and have run different images. `build_script_revision` is a content
digest of the build plan, not an upstream revision, and `artemis_revision` is unattested by
construction: no endpoint this backend uses reports the server's version. A hosted deployment will
report different tags, may pin digests, and is the only place those values mean anything.

**Build turnaround and timeout headroom.** Every timing here comes from one build agent on a 5-CPU
host with a warm image cache and no competing load. The 240 s ceiling that `non-terminating-test`
relies on is `artemis.continuous-integration.build-timeout-seconds.max` at its default; a deployment
that raises it, or that queues behind other courses, changes how long an evaluation takes and how
much `build_timeout_ms` headroom the evaluator needs. Nothing here calibrates that.

**The `emptyRepositories` gate is PR-specific.** §4.1's Hyperion gate is a property of PR #13156, not
of released Artemis. On a revision without it, `emptyRepositories=true` would be available and would
make repository reconciliation unnecessary. Whichever revision a deployment runs has to be re-checked;
the reconciliation is correct either way, but it is doing work that may not be needed.

**The timeout signature is matched on log text.** §6.5 detects a stopped build by matching
`Timed out after N seconds` / `java.util.concurrent.TimeoutException` in the build log, because
`BuildStatus.TIMEOUT` is only exposed by admin endpoints. That string is Artemis's, not a contract,
and it can change without notice. On a deployment where the evaluation account can hold admin rights,
reading the build-job status directly would be strictly better. Until then this is the one correction
resting on a message rather than a field, and it should be re-verified against each new Artemis.

**Concurrency.** Every run here was sequential, as `verify-m2-oracle.ts` intends — interleaving
builds would measure the queue rather than the exercises. Whether the backend's short names, exercise
cleanup and result baselining survive two evaluators running against the same course at once is
untested.

**Scale.** Eight cases, one course, one exercise at a time, all exercises deleted afterwards. Nothing
here exercises a course accumulating thousands of evaluation exercises, or the `recover` path against
a deployment that has been interrupted mid-build.

---

## Baseline and final state

Before any change: `bun run test` 668 pass, 1 skip, 0 fail; `lint`, `format:check`, `typecheck` green.

After Phase B: **`bun run test` 677 pass, 0 fail**, and `lint`, `format:check` and `typecheck` green.
The nine additional tests are the negative controls the corrections needed — seed-build
discrimination, the two feedback spellings, a build remark that must stay a diagnostic, a denied read
that is a failing test, and both directions of the timeout check.

## Guardrails observed

- Only the exercise's own four artifacts are pushed to Artemis. No sealed suite asset — hidden test,
  mutant or reference solution — is opened by this path. Repository reconciliation only ever deletes
  what Artemis seeded and writes what `readCandidateBundle` returned.
- Every LocalCI timeout and agent failure is `infra_failure`, never a quality verdict. This is now
  enforced rather than assumed: §6.5 reads the build log of a failed build precisely so that a build
  the queue gave up on cannot be reported as an exercise that does not compile.
- The verdict is a function of the bundle, never of the seed. §6.2's submission baseline exists
  because the alternative was observed to fail: a seed build of Artemis's own sorting exercise was
  admitted as this evaluation's build.
- `coverage.*` and `mutation.*` are `not_applicable` on both sides and stay declared for WP2c.
- Credentials exist only in `ARTEMIS_EVALUATION_USERNAME` / `ARTEMIS_EVALUATION_PASSWORD`. Neither
  value appears in this repository, the backend configuration, any log or this document.
- The Artemis checkout and all its data live outside the exgen-bench working tree.
- The local Artemis is throwaway. Its attestation values are not the production ones.
