# live-2arm-rerun

A check that two [arms](../../docs/GLOSSARY.md#arm) can run against a single Artemis deployment.
Three cases, two arms, 2026-08-01 16:18 UTC. **Not a measurement run.**

**6 planned attempts. 0 produced a candidate exercise.**

See [`../README.md`](../README.md) for what a committed run is and how to score one.

| | |
| --- | --- |
| Dataset | `hyperion-2arm-effort-probe` 1.0.0 — see below |
| Systems | `artemis-standard` and `artemis-draft`, both revision `artemis-production-api-v5-effort-profiles` |
| Deployment | one instance, `http://127.0.0.1:8080`, course 9014, serving both arms |
| Factor | `effort_profile`, control `requested`; `approach`, `model` and `provider` are equal and declared |
| Model | `openai/gpt-oss-120b`, served by an unbilled deployment |

## Purpose

Until Artemis gained [named configurations](../../docs/GLOSSARY.md#named-configuration), every
setting that shaped a generation was server-wide, so a second arm needed a second deployment and
could not be told apart from it. This run shows two arms differing in exactly one declared factor
while sharing everything else, and the manifest records what the profiles change: `artemis-draft`
reports `max_turns` 20, `max_job_duration_ms` 720000 and `max_tokens_per_job` 600000 against
`artemis-standard`'s 60, 2700000 and 3000000.

## Dataset

The run declares its own dataset, `hyperion-2arm-effort-probe`, which is **not in `datasets/`**, so
its identity and digest in `manifest.json` resolve to nothing published here. Its three briefs
(`recursion`, `encapsulation`, `intro-conditionals`) are byte-identical to the files of the same
names under `datasets/hyperion-development-v1/briefs/`, and that dataset
[declares them contaminated](../../datasets/hyperion-development-v1/README.md#limitations-and-governance):
verbatim from Artemis's own generation scenario list, and Hyperion was iterated against them.

## How the 6 attempts ended

| termination | n |
| --- | ---: |
| `AGENT_ERROR` | 3 |
| `DEADLINE_EXCEEDED` | 2 |
| `CONVERGED` | 1 |

All three `AGENT_ERROR` attempts died at Hyperion's concept-admission gate with no specification and
no repository files, each carrying the verbatim reasons its reviewer gave in
`attempts/<attempt-id>/output/artemis/terminal-status.json`. `recursion` failed in both arms.

## No scoreable candidate

The other three attempts produced artifacts, but all three are `state: "failed"` with
`error_code: "generator.attestation_mismatch"`, so none of them is a
[candidate exercise](../README.md#scoring-a-committed-run). None is scored and the run carries no
`evaluations/` directory. What the generator itself reported about those three — Artemis's own
`NEEDS_REVIEW` / `SUCCESS` verdicts and its review notes — is in each attempt's
`terminal-status.json`.

## What this run does not establish

**It says nothing about the two effort profiles.** Six attempts across two arms cannot compare them
and was never intended to. Read it as evidence that the machinery works, and nothing else. The
contaminated briefs are described above; no metric in this repository is validated against human
judgement (see
[`evaluators/promise-traceability/README.md`](../../evaluators/promise-traceability/README.md)).
