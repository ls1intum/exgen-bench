# live-2arm-rerun

A check that two [arms](../../docs/GLOSSARY.md#arm) can run against a single Artemis deployment.
Three cases, two arms, 2026-08-01 16:18 UTC. **Not a measurement run.**

**6 planned attempts. 3 produced a candidate exercise.**

See [`../README.md`](../README.md) for what a committed run is and how to score one.

| | |
| --- | --- |
| Dataset | `hyperion-2arm-effort-probe` 1.0.0 — see the caveat below |
| System | Artemis Hyperion, branch `hyperion-agentic-production-design`, two arms |
| Arms | `artemis-standard` and `artemis-draft`, differing only in the `effort_profile` factor |
| Model | `openai/gpt-oss-120b`, served by an unbilled deployment |

## Why it exists

Until Artemis gained [named configurations](../../docs/GLOSSARY.md#named-configuration), every
setting that shaped a generation was server-wide. A second arm therefore needed a second deployment,
and the arm could not be told apart from the deployment serving it — so no comparison was possible
at all. This run exists to show that two arms now differ in exactly one declared factor while
sharing everything else.

"rerun" is in the name because the first try wedged on eight adapter defects it uncovered, all since
fixed.

## The dataset caveat

The run declares its own dataset, `hyperion-2arm-effort-probe`, which is **not in `datasets/`** —
three cases assembled for the check, and "probe" is simply part of the name it was given. Its cases
(`recursion`, `encapsulation`, `intro-conditionals`) are drawn from `hyperion-development` and their
briefs are byte-identical, but the dataset identity and digest in `manifest.json` resolve to nothing
published in this repository.

## How the 6 attempts ended

| termination | n | produced a candidate exercise |
| --- | ---: | ---: |
| `AGENT_ERROR` | 3 | 0 |
| `DEADLINE_EXCEEDED` | 2 | 2 |
| `CONVERGED` | 1 | 1 |

All three `AGENT_ERROR` attempts died at Hyperion's concept-admission gate, with no specification
and no repository files, and each carries the verbatim reasons its reviewer gave. `recursion` failed
in both arms.

## The 3 candidate exercises

`NEEDS_REVIEW`, `SUCCESS` and review-note counts are **Artemis's own words for its own output**, not
an independent verdict.

| case | arm | Artemis's own status | Artemis review notes | behavioural test methods |
| --- | --- | --- | ---: | ---: |
| encapsulation | artemis-standard | NEEDS_REVIEW | 7 | 14 |
| intro-conditionals | artemis-standard | **SUCCESS** | 4 | 5 |
| encapsulation | artemis-draft | NEEDS_REVIEW | 8 | 3 |

[`evaluations/promise-traceability.md`](evaluations/promise-traceability.md) scores all three; none
has an unwitnessed promise.

## What this run does not establish

**It says nothing about the two effort profiles.** Six attempts across two arms, with one arm
producing a single exercise, cannot compare them and was never intended to. Read it as evidence that
the machinery works, and nothing else.

The general caveats apply too: one system, one revision, one model, one replicate; briefs from a
dataset that declares itself contaminated; no validated metric; and no deployment attestation, so a
release refuses to publish it.
