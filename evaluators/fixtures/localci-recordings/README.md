# Raw LocalCI result recordings

These are **raw Artemis build payloads** for the template and solution participations of one fixture
case, in the shapes a live Artemis really answers with:

```json
{
  "template": {
    "submission": { "id": 5101, "buildFailed": false, "commitHash": "…" },
    "result":     { "id": 4101, "completionDate": "…", "testCaseCount": 3, … },
    "feedbacks":  [ { "testCase": { "testName": "…" }, "positive": false, … } ]
  },
  "solution": { … }
}
```

Three things about that shape are load-bearing, and all three were wrong before WP8 Phase B:

- **The result is nested under a submission**, arriving as
  `participation.submissions[].results[]` from
  `GET /api/programming/programming-exercises/{id}/with-template-and-solution-participation?withSubmissionResults=true`.
  There is no participation-scoped results route on any base path; both the `api/exercise` and
  `api/assessment` spellings answer 404.
- **`buildFailed` lives on the submission**, not on the result.
- **The result carries no feedbacks.** They come from a second call,
  `GET /api/assessment/participations/{participationId}/results/{resultId}/details`, which returns a
  bare `Feedback[]`. Everything the verdict is computed from — test case names and outcomes —
  is in that second response.

## Why they exist

`oracle-recordings/` sits *below* the parsing boundary: it encodes the backend-agnostic
`BuildOutcome` that `FixtureBuildBackend` replays directly. Nothing in it exercises
`toSubmissionBuild()` in [`localci-backend.ts`](../../java-oracle/localci-backend.ts), which is the
function that turns Artemis's answer into that `BuildOutcome`. Without these payloads the two
backends could disagree about the same build and no fixture would notice.

`tests/evaluator-localci-mapping.test.ts` closes that gap: for every case here it asserts

```
toSubmissionBuild(localci-recordings/<case>.json .template) === oracle-recordings/<case>.json .template
toSubmissionBuild(localci-recordings/<case>.json .solution) === oracle-recordings/<case>.json .solution
```

and it parses these files with a **strict** schema, so a recording that drifted back to the flat
`Result`-with-inline-`feedbacks` shape fails rather than quietly passing. It also carries a negative
control that feeds the mapping the wrong feedbacks and requires the answer to change.

## Provenance — read this before treating them as evidence

**These payloads are hand-authored**, but they are hand-authored *against shapes observed on a live
Artemis*: PR #13156 was stood up locally in WP8 and every endpoint walked. See
[`docs/WP8-M2-LIVE.md`](../../../docs/WP8-M2-LIVE.md) §4 for the observed requests and responses.
They are still not captured traffic — no committed run under `runs/` contains a build result, because
those runs are **generation** evidence and Hyperion generation never triggers a template or solution
build.

So they validate **the mapping against a verified contract**, not a particular deployment's data. A
green mapping test means the evaluator is self-consistent and shaped like the real API; the live M2
run in `docs/WP8-M2-LIVE.md` §8 is what confirms a deployment agrees.

## Two contract facts these recordings make visible

1. **Coverage is unreachable through LocalCI, in both dimensions.** Artemis removed test-wise
   coverage support outright ([ls1intum/Artemis#9993](https://github.com/ls1intum/Artemis/pull/9993)),
   and `Result` carries no aggregate coverage field either — only `testCaseCount`,
   `passedTestCaseCount` and `codeIssueCount`. So no recording here carries coverage, and both
   `coverage.statement` and `coverage.branch` are `not_applicable` everywhere. They stay declared
   metrics for the container backend (WP2c) to fill.
2. **`non-terminating-test` has no recording here, deliberately.** Its whole point is that no result
   ever completes: the poll loop keeps reading a participation whose new results never arrive until
   the build timeout, and that is an `infra_failure` with no build result to map. A payload for it
   would contradict the fixture.
