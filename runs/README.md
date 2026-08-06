# Committed runs

A [run](../docs/GLOSSARY.md#run) is what the benchmark writes when it executes a plan. Normally runs
land in `.exgen/runs/`, which is gitignored because a run is working evidence. The runs here are the
exception: a few are committed so that anyone changing an evaluator can see what a real generation
system actually produced, without having to execute a benchmark first.

These directories are the benchmark's own output directory structure. `execution.results_dir`
defaults to `.exgen/runs`, and a committed run is the same thing under `runs/` instead.

**These are material to develop evaluators against, not results.** Nothing here is evidence for a
benchmark claim. See each run's `README.md` for what it is and what it does not establish.

## What is in one

Exactly what the benchmark wrote, with one removal explained below.

```
runs/<run-id>/
  manifest.json          the resolved plan, the systems, and their attestation
  ledger.sqlite          the harness's own progress ledger (binary)
  attempts/<attempt-id>/
    request.json         exactly what the system was given
    observation.json     outcome, usage, budget verdicts, reconciliation
    output/
      response.json      what the adapter reported
      artifacts/         problem-statement.md, template/, solution/, tests/ — when produced
      artemis/           system-side evidence: progress events, terminal status
      telemetry/         the full OpenTelemetry trace
  evaluations/
    <evaluator-id>.jsonl the evaluation journal
    <evaluator-id>.md    the rendered table, for reading
```

Attempts that produced no candidate exercise are kept. A system that produces nothing is telling you
something, and the reason is in `output/artemis/terminal-status.json`.

## The one removal, and what it costs

The template, solution and test repositories are exported from the system with their own `.git`
directories, and **git cannot track a nested `.git`**, so those are deleted before committing.

They are inside both the evidence manifest and the candidate exercise's `artifact_digest`, so a
committed run no longer matches its own recorded digests:

| command | on a committed run |
| --- | --- |
| `bun run cli status <run-dir>` | works |
| `bun run cli verify <run-dir>` | fails, `evidence digest mismatch` |
| `bun run cli evaluate process <run-dir>` | fails the same way — it verifies before scoring |

The commit each repository was exported at is recorded in the attempt's `generation-evidence.json`
regardless, so nothing about the generated exercise is lost. Everything except those `.git`
directories is byte-identical to what the benchmark wrote.

This is a defect in what gets digested rather than a property of committing runs: `.git/index`
stores per-file timestamps, so including it makes a candidate exercise's digest depend on when it
was exported rather than on its content. Tracked in
[#18](https://github.com/ls1intum/exgen-bench/issues/18); fixing it makes future runs committable
with no removal at all.

## Scoring a committed run

Because `evaluate process` verifies first, it cannot read these. Use:

```sh
bun run scripts/score-run.ts runs/<run-id> evaluators/<evaluator>/config.yaml
bun run evaluators/<evaluator>/report.ts runs/<run-id>/evaluations/<evaluator-id>.jsonl
```

`score-run.ts` writes the journal where `evaluate process` would write it and in the same shape; it
skips the verification a committed run cannot pass. That is the whole difference. It exists until
[#17](https://github.com/ls1intum/exgen-bench/issues/17) is resolved.

Both the journal and the rendered report are committed, so changing a metric produces a reviewable
diff rather than a number someone reports.

## Committing a new one

Copy the run out of `.exgen/runs/`, delete the exported repositories' `.git` directories, and write
a `README.md` next to it saying which dataset and which system at which revision produced it, and
what it does not establish.

**A run contains raw telemetry, which is every prompt and completion the system produced.**
Committing one publishes them, irreversibly. Do that only for a system whose prompts are open, scan
for credentials first, and never for a run over a restricted or sealed dataset.
