# hyperion-development-v1-live-20260731d

The whole 19-case [`hyperion-development`](../../datasets/hyperion-development-v1/README.md) dataset
run against Artemis Hyperion, one generation system, one replicate. Started 2026-07-31 21:48 UTC.

**19 planned attempts. 11 produced a candidate exercise.**

See [`../README.md`](../README.md) for what a committed run is and how to score one.

| | |
| --- | --- |
| Dataset | `hyperion-development` 1.0.0, held in `datasets/hyperion-development-v1/` |
| System | `artemis`, revision `artemis-production-api-v3-otel` |
| Model | `openai/gpt-oss-120b`, served by an unbilled deployment |

## How the 19 attempts ended

| termination | n | produced a candidate exercise |
| --- | ---: | ---: |
| `NO_SCHEDULABLE_SURFACE` | 5 | 5 |
| `AGENT_ERROR` | 5 | 0 |
| `TOKEN_BUDGET_EXHAUSTED` | 3 | 2 |
| `REVIEW_UNAVAILABLE` | 2 | 2 |
| `CONVERGED` | 1 | 1 |
| `DEADLINE_EXCEEDED` | 1 | 1 |
| `MECHANICAL_REPAIR_EXHAUSTED` | 1 | 0 |
| `UNCHANGED_CANDIDATE_RESUBMITTED` | 1 | 0 |

Only one attempt ended because the system decided it was finished.

Four of the five `AGENT_ERROR` attempts died at Hyperion's concept-admission gate, after spending
under 2% of the token budget, with no specification and no repository files at all. Each of those
four carries the verbatim reasons Hyperion's own reviewer gave for rejecting every candidate
concept, in `attempts/<attempt-id>/output/artemis/terminal-status.json`. That is the clearest
evidence here about *why* the system fails.

## The 11 candidate exercises

`NEEDS_REVIEW`, `SUCCESS` and the review-note counts are **Artemis's own words for its own output**
— its reviewer grading its generator. They are recorded because they are part of what the system
produced. They are not an independent verdict.

| case | Artemis's own status | Artemis review notes | behavioural test methods | statement chars |
| --- | --- | ---: | ---: | ---: |
| immutable-value | NEEDS_REVIEW | 7 | 15 | 3528 |
| inheritance | NEEDS_REVIEW | 5 | 12 | 3549 |
| string-parsing | **SUCCESS** | 0 | 12 | 4164 |
| interval-merge | NEEDS_REVIEW | 5 | 8 | 3320 |
| collections | NEEDS_REVIEW | 3 | 7 | 5081 |
| intro-formatting | NEEDS_REVIEW | 4 | 7 | 2284 |
| robot-rover | NEEDS_REVIEW | 8 | 7 | 3438 |
| graph-cycles | NEEDS_REVIEW | 4 | 6 | 2478 |
| state-machine | NEEDS_REVIEW | 1 | 5 | 2763 |
| bicycle-share-summary | NEEDS_REVIEW | 3 | 4 | 3019 |
| library-checkout | NEEDS_REVIEW | 1 | 4 | 2640 |

Test-method counts span nearly four-fold across exercises that all passed the same
[target check](../../docs/GLOSSARY.md#target-check) inside Artemis — reference solution passes,
template fails. That spread is what the first evaluator was built to see.

## Evaluation

[`evaluations/promise-traceability-promise-traceability-study-93d2971afb0c.md`](evaluations/promise-traceability-promise-traceability-study-93d2971afb0c.md) is the rendered result
of the [promise-traceability](../../evaluators/promise-traceability/README.md) evaluator over these
11 exercises; the `.jsonl` beside it is the journal it was rendered from.

Seven [unwitnessed](../../docs/GLOSSARY.md#witness) promises across four exercises — statement
promises with no assertion that would fail if they were broken. Each confirmed by hand against the
test sources:

- **collections** — three. The statement requires that the supplied list is not modified and that a
  null argument throws `NullPointerException`; the suite contains no `assertThrows` at all.
- **library-checkout** — two. The statement says `summarize` *"must never return null and must never
  modify the supplied list"*, and its four test methods check neither.
- **inheritance** — one. "The classes are immutable", with no mutation check anywhere.
- **string-parsing** — one. "store them immutably" — and this is the one exercise Artemis marked
  `SUCCESS` with no review notes.

## What this run does not establish

- **One system, one revision, one model, one replicate.** No rate computed here generalises.
- **The briefs are contaminated**, and
  [the dataset declares it](../../datasets/hyperion-development-v1/README.md#limitations-and-governance)
  in machine-readable form: they are verbatim from Artemis's own generation scenario list, authored
  by Hyperion's maintainer, and Hyperion was iterated against them.
- **No metric is validated** against human judgement; see
  [`evaluators/promise-traceability/README.md`](../../evaluators/promise-traceability/README.md).
- **No deployment attestation.** `manifest.json` records no `attestation.deployment_deviations` for
  the `artemis` system, so `exgen release` refuses to publish this run.
