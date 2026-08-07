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
  manifest.json            the resolved plan, the systems, and their attestation
  ledger.sqlite            the harness's own progress ledger (binary)
  attempts/<attempt-id>/
    request.json           exactly what the system was given
    observation.json       outcome, usage, budget verdicts, reconciliation
    evidence-manifest.json the digest of every file the attempt wrote
    stdout.log, stderr.log the adapter's own streams
    output/
      response.json        what the adapter reported
      artifacts/           problem-statement.md, template/, solution/, tests/ — when produced
      artemis/             system-side evidence: adapter state, progress events, terminal status,
                           and the commits each exported repository was taken at
      telemetry/           the full OpenTelemetry trace
  evaluations/             absent when the run has no candidate exercise
    <journal>.jsonl        the evaluation journal, named by the harness
    <journal>.md           the rendered table, redirected here for reading
```

A journal is named `<evaluator-id>-<suite-id>-<12 hex>`, where the twelve hex digits digest the
evaluator identity, the suite, the requested metrics and the timeout, so two evaluator
configurations cannot overwrite each other's journal. The `.md` is not written by any tool; see
below.

Attempts that produced no candidate exercise are kept: the reason a system produced nothing is in
`output/artemis/terminal-status.json`.

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
bun run evaluators/<evaluator>/report.ts runs/<run-id>/evaluations/<journal>.jsonl \
  > runs/<run-id>/evaluations/<journal>.md
```

`score-run.ts` prints the journal path it wrote. `report.ts` writes the table to stdout and nothing
to disk, so the redirect above is what produces the committed `.md`.

`score-run.ts` calls the same source loader, configuration loader, process executor and journal
writer as `evaluate process`, on the candidates the run's own manifest and ledger declare. The one
step it skips is the evidence verification, and skipping it is recorded rather than silent: the
evaluator revision it writes is the configured one with `-unverified` appended. That changes every
`evaluation_id` and the journal's identity digest, so an unverified journal is never mistakable for
a verified one, and the two never land in the same file. It exists until
[#17](https://github.com/ls1intum/exgen-bench/issues/17) is resolved.

It scores candidate exercises as the harness defines them: an attempt that completed and carries an
artifact digest. An attempt that produced artifacts but was not accepted — an attestation mismatch,
say — is not a candidate and is not scored, so a run with none carries no `evaluations/`.

Both the journal and the rendered report are committed, so changing a metric produces a reviewable
diff rather than a number someone reports.

## Committing a new one

Copy the run out of `.exgen/runs/`, delete the exported repositories' `.git` directories, and write
a `README.md` next to it saying which dataset and which system at which revision produced it, and
what it does not establish.

**A run contains raw telemetry, which is every prompt and completion the system produced.**
Committing one publishes them, irreversibly. Do that only for a system whose prompts are open, scan
for credentials first, and never for a run over a restricted or sealed dataset.
