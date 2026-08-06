# Corpora

A corpus is a set of **candidate exercises a generation system actually produced**, kept in the
repository so evaluators can be built and compared against real output.

`datasets/` holds the briefs a system is asked to work from. A corpus holds what came back.

## Why this exists as its own tier

Evaluator development needs real candidates, and the alternatives are worse. Run directories under
`.exgen/` are gitignored, contain prompt and completion content, and are far too large to check in.
A published release under `releases/` carries outcomes and metadata but not the generated exercises
themselves, because a release is a disclosure-filtered scientific artifact rather than a working
fixture. Without a corpus, anyone changing a metric has to re-run a campaign to see what changed.

A corpus is therefore the one place where generated candidate content is deliberately committed. It
is a development fixture, not a result. Nothing here is evidence for a benchmark claim.

## What a corpus contains

```
<corpus-id>/
  README.md            provenance, composition, caveats
  manifest.json        identity, dataset, producing system, per-candidate digests
  candidates/<slug>/
    response.json      the generation response, artifact paths rebased to this directory
    outcome.json       outcome, termination reason, usage, review-note count, brief
    problem-statement.md
    template/  solution/  tests/
  evaluations/
    <evaluator-id>.jsonl   the evaluation journal, one response per candidate
    <evaluator-id>.md      the rendered table and unexercised-promise list
```

`response.json` is present because an evaluator locates artifacts through the generation contract
rather than by directory convention. Keeping it means a corpus candidate is read by exactly the same
code path as a live one, so an evaluator that works here works in a campaign.

Telemetry is never included. It is restricted evidence and stays in the run directory.

## Working with a corpus

Re-score after changing a metric, and read the diff:

```sh
bun run scripts/score-corpus.ts corpora/<corpus-id> evaluators/<evaluator>/config.yaml
bun run evaluators/<evaluator>/report.ts corpora/<corpus-id>/evaluations/<evaluator>.jsonl
```

Both output files are checked in, so a metric change shows up as a reviewable diff rather than as a
number someone reports. That is the point of committing the results alongside the candidates.

## Adding one

Name it `<dataset-id>-<collection-date>`. Record in `manifest.json` which dataset, which system, at
which revision, with which model, and a content digest per candidate. State plainly in its README
what the corpus does **not** establish — a corpus is a convenience sample of one system's output,
usually from a development dataset, and it is not a sampling frame for any claim.
