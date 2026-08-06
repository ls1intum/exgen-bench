# Corpora

A corpus is **what a generation system actually produced on a run**, committed so evaluators can be
built and compared against real output.

`datasets/` holds the briefs a system is asked to work from. A corpus holds what came back —
including the attempts where nothing came back, because a system that produces nothing is telling
you something.

## Why this exists as its own tier

Evaluator development needs real output, and the alternatives are worse. Run directories under
`.exgen/` are gitignored and dominated by telemetry. A published release under `releases/` carries
outcomes and metadata but not the generated exercises, because a release is a disclosure-filtered
scientific artifact rather than a working fixture. Without a corpus, anyone changing a metric has to
re-run a campaign to see what changed.

A corpus is therefore the one place generated candidate content is deliberately committed. It is a
development fixture, not a result, and nothing in it is evidence for a benchmark claim.

## A corpus is not a run directory

This distinction is load-bearing. **A run directory carries an integrity claim**: its evidence
manifest digests every file the attempt produced, and `exgen verify` checks them. A corpus copies
attempts out of real runs with telemetry removed, so it cannot honour that claim — and re-digesting
what remains would produce an artifact certifying itself complete when it is not.

So a corpus does not pretend to be a run. `exgen verify` is not expected to pass on it, its manifest
says so, and every removed file is listed per attempt under `omitted_evidence` with its original
digest, so the link back to the real evidence stays checkable.

**Telemetry is the one thing always removed.** It is roughly 95% of a run by size and it contains
every prompt and completion the system produced, including its system prompts. That is a disclosure
decision rather than a size one: it stays in the run directory and travels only through a
[restricted archive](../docs/RESTRICTED-ARCHIVES.md).

## Layout

```
<corpus-id>/
  README.md            provenance, composition, caveats
  manifest.json        identity, per-attempt digests, and what was omitted
  summary.csv          one row per planned attempt
  attempts/<slug>/
    request.json       exactly what the system was given
    observation.json   harness outcome, usage, budget verdicts, reconciliation
    response.json      the generation response
    artemis/           system-side evidence: progress events, terminal status
    artifacts/         problem-statement.md, template/, solution/, tests/ — when produced
  evaluations/
    <evaluator-id>.jsonl   the evaluation journal, one response per candidate
    <evaluator-id>.md      the rendered table and unexercised-promise list
```

Attempt directories keep the run's own `output/` shape, so `artifacts/` paths in `response.json` are
unmodified and an evaluator reads a corpus candidate through exactly the same code path as a live
one. An evaluator that works here works in a campaign.

## Working with a corpus

Re-score after changing a metric, and read the diff:

```sh
bun run scripts/score-corpus.ts corpora/<corpus-id> evaluators/<evaluator>/config.yaml
bun run evaluators/<evaluator>/report.ts corpora/<corpus-id>/evaluations/<evaluator>.jsonl
```

Both output files are checked in, so a metric change arrives as a reviewable diff rather than as a
number someone reports. That is the point of committing results beside the output.

## Adding one

Name it `<dataset-id>-<collection-date>`. Record which dataset, which system at which revision, with
which model, a digest per attempt, and what was omitted. State plainly what the corpus does **not**
establish — a corpus is a convenience sample of one system's output, usually from a development
dataset, and it is not a sampling frame for any claim.

A corpus drawn from a restricted or sealed dataset must not be committed at all.
