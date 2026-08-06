# Corpora

A corpus is **a run, as it was produced**, committed so evaluators can be built and compared against
real output.

`datasets/` holds the briefs a system is asked to work from. A corpus holds what came back — every
attempt, including the ones that produced nothing, every artifact, and the full telemetry.

## Why this exists as its own tier

Evaluator development needs real output. Run directories under `.exgen/` are gitignored, and a
published release under `releases/` carries outcomes and metadata rather than the generated
exercises, because a release is a disclosure-filtered scientific artifact. Without a corpus, anyone
changing a metric has to re-run a campaign to see what changed.

A corpus is therefore the one place a run is deliberately committed. It is a development fixture,
not a result, and nothing in it is evidence for a benchmark claim.

## Nothing is filtered, summarised or repacked

Run directories are committed as plain files, unchanged, so every attempt is browsable and diffable
and the ordinary commands work on them directly. There is no corpus-specific tooling and no
extraction step.

**One exception, and it is unavoidable.** The exported template, solution and test repositories each
carry their own `.git` directory, and git cannot track a nested one. Those directories are removed.
They are inside the evidence manifest — 21 of the 53 digested files in a typical attempt — so
`exgen verify` reports missing files on a corpus run. Everything a reader would want from them is
recorded elsewhere anyway: the commit each repository was exported at is in the attempt's
`generation-evidence.json` and in `saved_repository_commits`.

```
<corpus-id>/
  README.md
  runs/<run-id>/         the run directory, minus the exported repositories' .git
  evaluations/
    <evaluator-id>.jsonl the journal, as produced by the real CLI
    <evaluator-id>.md    the rendered table and unexercised-promise list
```

## Working with a corpus

The ordinary commands, pointed at a run:

```sh
bun run cli status corpora/<corpus-id>/runs/<run-id>
bun run cli evaluate process corpora/<corpus-id>/runs/<run-id> \
  --config evaluators/<evaluator>/config.yaml
bun run evaluators/<evaluator>/report.ts \
  corpora/<corpus-id>/runs/<run-id>/evaluations/<journal>.jsonl
```

The journal and rendered report under `evaluations/` are the current state of that evaluator over
that corpus, checked in so a metric change arrives as a reviewable diff rather than as a number
someone reports.

## Adding one

Name it `<dataset-id>-<collection-date>`. Record which dataset, which system at which revision, and
with which model. State plainly what the corpus does **not** establish — a corpus is a convenience
sample of one system's output, usually from a development dataset, and is not a sampling frame for
any claim.

**A corpus contains raw telemetry, which means every prompt and completion the system produced.**
Committing one publishes them, irreversibly. Do that only for a system whose prompts are open, scan
for credentials first, and never for a corpus drawn from a restricted or sealed dataset.
