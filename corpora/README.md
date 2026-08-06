# Corpora

A [corpus](../docs/GLOSSARY.md#corpus) is **a [run](../docs/GLOSSARY.md#run), as it was produced**,
committed so evaluators can be built and compared against real output.

`datasets/` holds the briefs a system is asked to work from. A corpus holds what came back — every
[planned attempt](../docs/GLOSSARY.md#planned-attempt), including the ones that produced nothing,
every artifact, and the full telemetry.

## Why this exists as its own tier

Evaluator development needs real output. Run directories under `.exgen/` are gitignored, and a
published release under `releases/` carries outcomes and metadata rather than the generated
exercises, because a release is a disclosure-filtered scientific artifact. Without a corpus, anyone
changing a metric has to re-run a whole benchmark to see what changed.

A corpus is therefore the one place a run is deliberately committed. It is material to develop
against, not a result, and nothing in it is evidence for a benchmark claim.

## Nothing is filtered, summarised or repacked

Run directories are committed as they were written, so every attempt is browsable and diffable and
nothing has to be unpacked to read it. Two files per run are the harness's own SQLite ledgers, which
are binary; everything else is text.

**One thing is removed, and it is unavoidable.** The exported template, solution and test
repositories each carry their own `.git` directory, and git cannot track a nested one. Those
directories are deleted. They are inside the evidence manifest — 21 of the 44 to 55 digested files
in an attempt that produced a [candidate exercise](../docs/GLOSSARY.md#candidate-exercise) — so the
harness's evidence check fails on a corpus run: `bun run cli verify` **and** `bun run cli evaluate
process` both exit non-zero with `evidence digest mismatch`. Only `bun run cli status` works
unchanged. The commit each repository was exported at is recorded in the attempt's
`generation-evidence.json` regardless.

```
<corpus-id>/
  README.md
  runs/<run-id>/         the run directory, minus the exported repositories' .git
  evaluations/
    <evaluator-id>.jsonl the evaluation journal over the corpus's candidate exercises
    <evaluator-id>.md    the rendered table and unwitnessed-promise list
```

## Working with a corpus

`status` reads a corpus run directly:

```sh
bun run cli status corpora/<corpus-id>/runs/<run-id>
```

`evaluate process` does not, because of the removed `.git` directories above. The journal under
`evaluations/` is therefore not its output: it is the evaluator's own scores over the corpus's
candidate bundles, collected across the corpus's runs into one file. Re-render it for a human reader
with:

```sh
bun run evaluators/<evaluator>/report.ts \
  corpora/<corpus-id>/evaluations/<evaluator-id>.jsonl
```

The journal and the rendered report are checked in so that a metric change arrives as a reviewable
diff rather than as a number someone reports. Producing the new journal after such a change is not
yet a command in this repository, which is the open end of this tier.

## Adding one

Name it after the dataset directory and the collection date, as
`<dataset-directory>-<collection-date>`. Record the dataset's declared `id` and `version` too, since
a directory name and a dataset identity are allowed to differ and only the identity appears in a run
manifest. Record which system at which revision, and with which model. State plainly what the corpus
does **not** establish — a corpus is a convenience
sample of one system's output, usually from a development dataset, and is not a
[sampling frame](../docs/GLOSSARY.md#sampling-frame) for any claim.

**A corpus contains raw telemetry, which means every prompt and completion the system produced.**
Committing one publishes them, irreversibly. Do that only for a system whose prompts are open, scan
for credentials first, and never for a corpus drawn from a restricted or sealed dataset.
