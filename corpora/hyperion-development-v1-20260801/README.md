# hyperion-development-v1-20260801

Two live runs of Artemis Hyperion, committed **as they were produced** — all 25 planned attempts,
every artifact, and the full OpenTelemetry traces. See [`../README.md`](../README.md) for what a
[corpus](../../docs/GLOSSARY.md#corpus) is.

**This is material to develop evaluators against, not a result.** Read the caveats before quoting
any number from it.

## Provenance

| | |
| --- | --- |
| Dataset | `hyperion-development` 1.0.0, 19 Java briefs, held in `datasets/hyperion-development-v1/` |
| System | Artemis Hyperion, branch `hyperion-agentic-production-design` |
| Model | `openai/gpt-oss-120b`, served by an unbilled deployment |
| Collected | 2026-08-01 |

## What each run is

Run directories keep the working names they were given, because the name is part of what was
produced. Neither explains itself, so:

### `runs/hyperion-development-v1-live-20260731d/` — the measurement run

The whole 19-case [`hyperion-development`](../../datasets/hyperion-development-v1/README.md)
dataset, one generation system, one replicate, so 19 planned attempts. Started 2026-07-31 21:48 UTC.
**11 produced a candidate exercise.**

The `d` suffix marks the fourth try at this run — *attempt* is reserved here for a planned attempt
inside a run. Runs `a` through `c` were abandoned part-way when
harness defects surfaced — a telemetry parser that rejected the token encoding Artemis actually
emits, and then the same class of defect in finish reasons. Only `d` ran to completion, and it is
the only one kept.

### `runs/live-2arm-rerun/` — the two-arm contract check

Not a measurement run. Three cases, two [arms](../../docs/GLOSSARY.md#arm), six planned attempts,
2026-08-01 16:18 UTC. **3 produced a candidate exercise.**

Its purpose was to prove that two arms could coexist in a single Artemis deployment, which had been
impossible before Artemis gained [named configurations](../../docs/GLOSSARY.md#named-configuration):
every generation knob was server-wide configuration, so a second arm needed a second deployment and
was confounded with it. The two arms here differ in exactly one factor, `effort_profile` —
`standard` against `draft` — and everything else is held fixed.

"rerun" because the first try wedged on eight adapter defects it uncovered, all since fixed.

It declares its own dataset, `hyperion-2arm-effort-probe`, which is **not** in `datasets/` — three
cases assembled for the check, and "probe" is simply part of the name it was given. Its cases
(`recursion`, `encapsulation`, `intro-conditionals`) are drawn from `hyperion-development` and their
briefs are byte-identical, but the dataset identity and digest in that run's manifest resolve to
nothing published here.

Six attempts across two arms is far too small to compare the profiles, and the run was never
intended to. Do not read it as a paired comparison.

## What is in the two runs together

132 MB of files across 512 paths, nothing filtered, summarised or repacked.

The eleven attempts that produced no candidate exercise are here too, and they are not filler. Seven
died at Hyperion's concept-admission gate having spent under 2% of the token budget, with no
specification and no repository state at all, and each of the seven carries the verbatim reasons
Hyperion's own reviewer gave for rejecting the concept, in that attempt's
`output/artemis/terminal-status.json`. That is the best evidence we have about *why* the system
fails, and the input for measuring whether changing the gate helps. The other four got further and
failed later: two on Hyperion's own mechanical verification after writing a specification and
repository files, one when it exhausted the token budget, and one on an agent error part-way
through.

Thirteen of the fourteen candidate exercises carry Artemis **review notes** (1–8 each); one came
back with none. Review notes and the `NEEDS_REVIEW` and `SUCCESS` labels below are **Artemis's own
words for its own output** — its reviewer grading its generator. They are recorded here because they
are part of what the system produced, and they are not an independent quality verdict on anything.

## Composition of the 14 candidate exercises

| case | system | Artemis's own status | Artemis review notes | behavioural test methods | statement chars |
| --- | --- | --- | ---: | ---: | ---: |
| immutable-value | artemis | NEEDS_REVIEW | 7 | 15 | 3528 |
| encapsulation | artemis-standard | NEEDS_REVIEW | 7 | 14 | 3097 |
| inheritance | artemis | NEEDS_REVIEW | 5 | 12 | 3549 |
| string-parsing | artemis | **SUCCESS** | 0 | 12 | 4164 |
| interval-merge | artemis | NEEDS_REVIEW | 5 | 8 | 3320 |
| collections | artemis | NEEDS_REVIEW | 3 | 7 | 5081 |
| intro-formatting | artemis | NEEDS_REVIEW | 4 | 7 | 2284 |
| robot-rover | artemis | NEEDS_REVIEW | 8 | 7 | 3438 |
| graph-cycles | artemis | NEEDS_REVIEW | 4 | 6 | 2478 |
| state-machine | artemis | NEEDS_REVIEW | 1 | 5 | 2763 |
| intro-conditionals | artemis-standard | **SUCCESS** | 4 | 5 | 1704 |
| bicycle-share-summary | artemis | NEEDS_REVIEW | 3 | 4 | 3019 |
| library-checkout | artemis | NEEDS_REVIEW | 1 | 4 | 2640 |
| encapsulation | artemis-draft | NEEDS_REVIEW | 8 | 3 | 2428 |

Test-method counts span five-fold across exercises that all cleared the same mechanical bar — the
reference solution passes the tests and the template fails them. That spread is what the first
evaluator was built to see.

Two cases appear twice, from the two-arm run. They are not a paired comparison and should not be
read as one.

## Current evaluation state

[`evaluations/promise-traceability.md`](evaluations/promise-traceability.md) is the rendered result
of the [promise-traceability](../../evaluators/promise-traceability/README.md) evaluator over all 14
candidate exercises, from both runs; `promise-traceability.jsonl` is the journal it was rendered
from. [`../README.md`](../README.md) explains how that journal was produced and why
`evaluate process` cannot reproduce it.

Seven [unwitnessed](../../docs/GLOSSARY.md#witness) promises across four candidate exercises — that
is, seven statement promises with no assertion that could fail if they were broken. Each was
confirmed by hand against the test sources:

- **collections** — three. The statement requires that the supplied list is not modified and that a
  null argument throws `NullPointerException`; the suite contains no `assertThrows` at all.
- **library-checkout** — two. The statement says `summarize` *"must never return null and must never
  modify the supplied list"*, and its four test methods check neither.
- **inheritance** — one. "The classes are immutable", with no mutation check anywhere.
- **string-parsing** — one. "store them immutably". This is the only candidate exercise Artemis
  marked `SUCCESS` with no review notes.

The two measures do not agree. Ranking the 14 candidate exercises by `promise.unwitnessed_claims`
and by Artemis's review-note count gives a Spearman correlation of −0.50 (Pearson −0.44). Read that
number carefully: only 4 of the 14 have any unwitnessed promise at all, so the whole rank
correlation rests on those four, and no confidence interval is quoted because 14 observations from
one system on contaminated briefs would not support one. It is consistent with the two measuring
different things — the note count tracking how hard the case was to generate, not test adequacy —
but that is a reading of fourteen points, not a finding.

## What the telemetry contains

The traces are complete: `gen_ai.input.messages` and `gen_ai.output.messages` for every model call,
which is **Hyperion's full system prompts, the agent's reasoning, and every tool call**. Committing
this corpus publishes them, which is intended — the prompt engineering is open source.

Two consequences, stated here rather than left to be discovered: it worsens contamination of a
dataset that already declares itself contaminated, since the exact prompts and the exact generated
exercises are now both public; and publication is not undone by rewriting history.

Both runs were scanned before committing. No credentials, API keys, tokens or private keys appear.

## What this corpus does not establish

- **It is not a sample from any frame.** One generation system, one revision, one model. No rate
  computed here generalises, and the two runs are not comparable with each other — different
  datasets, different purposes, and one of them is a contract check.
- **The briefs are contaminated.** They come verbatim from Artemis's own generation scenario list,
  authored by Hyperion's maintainer, and Hyperion was iterated against them. The dataset declares
  this in machine-readable form.
- **No metric here is validated.** Every metric card is `AUTHOR_DECLARED` with an empty evidence
  list. Nothing has been checked against human judgement.
- **Artemis's `SUCCESS` and `NEEDS_REVIEW` are not evaluations.** They are the system under test
  reporting on itself. The independent measurement in this corpus is the evaluator journal, and it
  scores no candidate exercise as good or bad — only as measurable.
- **Neither run carries a deployment attestation.** Both predate the requirement, so the tooling
  warns and a release refuses to publish them.
- **`bun run cli verify` and `bun run cli evaluate process` both fail on these runs**, with
  `evidence digest mismatch`, because the exported repositories' `.git` directories are inside the
  evidence manifest and git cannot track a nested one. That is the honest cost of committing
  browsable files rather than an archive. `bun run cli status` works normally, and the commit each
  repository was exported at is in `generation-evidence.json`.
