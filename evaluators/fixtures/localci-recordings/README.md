# Raw LocalCI result recordings

These are **raw Artemis result payloads** — what `GET /api/exercise/participations/{id}/results`
returns — for the template and solution participations of one fixture case.

## Why they exist

`oracle-recordings/` sits *below* the parsing boundary: it encodes the backend-agnostic
`BuildOutcome` that `FixtureBuildBackend` replays directly. Nothing in it exercises
`toSubmissionBuild()` in [`localci-backend.ts`](../../java-oracle/localci-backend.ts), which is the
function that turns Artemis's answer into that `BuildOutcome`. Before WP8 the mapping was covered
only by inline payloads in one test, so the two backends could disagree about the same build and no
fixture would notice.

`tests/evaluator-localci-mapping.test.ts` closes that gap: for every case here it asserts

```
toSubmissionBuild(localci-recordings/<case>.json .template) === oracle-recordings/<case>.json .template
toSubmissionBuild(localci-recordings/<case>.json .solution) === oracle-recordings/<case>.json .solution
```

so the offline contract now pins both layers, and M2 against a live deployment becomes a diff rather
than a first encounter.

## Provenance — read this before treating them as evidence

**These payloads are hand-authored**, written against `resultSchema` in `localci-backend.ts`. They
are *not* captured from a deployment. No committed run under `runs/` contains a build result at all:
those runs are **generation** evidence (`generation-evidence.json`, `terminal-status.json`,
`events.jsonl`), and Hyperion generation never triggers a template or solution build.

So they validate **the mapping, not the deployment**. Field names, nesting and types are only as
right as the schema they were written against. Confirming that Artemis really answers in this shape
is M2, and M2 needs input I1. Until then, treat a green mapping test as "the evaluator is
self-consistent", never as "the endpoint contract is verified".

## Two contract facts these recordings make visible

1. **Branch coverage is unreachable through LocalCI.** `coverageFrom()` reads
   `coverageFileReportsByTestCaseName`, whose entries carry `coveredLineCount`, `missedLineCount`
   and `lineCount` — line counts only — and it therefore hard-returns `branch: null`. Recordings
   that asserted a branch number were asserting something this backend cannot produce, so
   `coverage.branch` is now `not_applicable` everywhere. It stays a declared metric for the
   container backend (WP2c) to fill.
2. **`non-terminating-test` has no recording here, deliberately.** Its whole point is that no result
   ever completes: `awaitResult` keeps polling results that have no `completionDate` until the build
   timeout, and that is an `infra_failure` with no build result to map. A payload for it would
   contradict the fixture.
