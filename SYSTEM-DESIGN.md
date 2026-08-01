# System design

This document explains the components that run a benchmark and the records they save. The
[glossary](docs/GLOSSARY.md) defines the project terms used here.

## At a glance

![Four stages of an exgen-bench run: plan, generate, evaluate, and release.](docs/images/system-overview.png)

The benchmark compares complete generation systems rather than models alone:

1. The plan fixes the cases, systems, repetitions, and resource limits.
2. A generator adapter runs each system and records its output or failure.
3. Target checks and a separately versioned evaluator inspect each candidate exercise.
4. The release contains every planned outcome, summary data, method details, and checksums.

## Interfaces

Generator adapters run as separate processes. JSON requests, JSON responses, and declared artifact
paths are the public interface; TypeScript types are internal. Study evaluators use the same kind of
boundary through the process-evaluator protocol. The built-in file-completeness check runs inside the
benchmark process; it is a development tool, not isolation for a formal study.

A benchmark configuration fixes:

- dataset version and digest;
- target version and revision;
- system versions, revisions, factors, runtime, and parameters;
- repetitions, paired seeds, budgets, and concurrency; and
- analysis method, contrasts, and registration metadata.

Before a run, each generator describes its name, version, and supported targets. This description
must match the configuration. The runner saves it in the run manifest and checks it again when a
run continues.

## Identity

The runner gives different records different IDs:

| Record | What its ID represents |
| --- | --- |
| Plan | The complete, resolved comparison design |
| Planned attempt | One case, generation system, and repetition |
| Generation key | The case, system, target, seed, and budget |
| Observation | What happened when one planned attempt ran |
| Evaluation | The candidate, evaluator, test suite, metrics, and time limit |

The runner hashes a stable JSON representation to create these IDs. Candidate hashes include each
file's role and a sorted file tree. Identical files do not merge two attempts, and changing an
evaluator does not rerun generation.

## Execution and resume

The runner writes the complete plan before generation starts. SQLite coordinates work and stores
events. A bounded queue can run attempts in parallel. Each attempt writes to a temporary directory;
the runner moves it into its final location only after the response, declared files, and evidence
manifest pass validation. Malformed or partial output may remain in the private evidence directory
for diagnosis.

The runner does not modify a finished attempt directory. If a remote generation might still be
running, the runner asks an adapter that supports recovery to cancel it. If cancellation cannot be
confirmed, the attempt remains running so `resume` can try again. After recovery from a runner
crash, the attempt is marked `interrupted` and is not sampled again automatically. `resume` starts
only attempts that are still planned.

Limits always cover elapsed time and may also cover model calls, tool calls, tokens, and cost. The
runner enforces elapsed time. Adapters report observed use, whether the requested random seed was
used, and whether provider request IDs were captured.

## Evaluation

Evaluation has its own resumable record. A candidate can be checked with a new evaluator or test
suite without changing or regenerating it.

A process evaluator runs under a versioned configuration that is bound to every request and recorded
in the evaluation identity. The executor bounds the request, the response, and the logs; it stops and
reaps child processes on timeout, and it can run a recovery command before classifying uncertain
work. Terminal responses are replayed from an append-only journal, so only infrastructure failures
can be retried. The evaluation kernel contains no target-specific code.

Generation outcomes and evaluation outcomes remain separate:

- executor or protocol failures have no candidate;
- a generator may fail or abstain while completing normally;
- an evaluator may reject a complete candidate on quality grounds; and
- evaluator infrastructure failures have no quality verdict.

A strict success requires a complete candidate exercise, evaluator acceptance, and evidence that
the attempt stayed within its resource limits. Its share of planned attempts is the exercise
success rate.

## Releases

A release contains versioned JSONL and CSV data, analysis summaries, metric descriptions,
checksums, Croissant metadata, and an RO-Crate. Its manifest lists every published file and hash;
`exgen release verify` detects later changes.

The public export removes arbitrary runtime parameters, local paths, evaluator messages, and
evidence locations. Hashes can link public records to a separately retained private archive. The
static site reads a verified release and does not recalculate study results.

## Artemis

Artemis is measured as a whole production deployment, not as a benchmark-only endpoint. The adapter
signs in to an ordinary Artemis instance, creates the entities a course author would create, starts
the normal generation job, follows its status, and reads the persisted exercise and repositories back
out. The database, version control, build agents, quotas, and save behavior are part of what is being
measured.

Artemis therefore needs no benchmark controller, benchmark database, or schema change. Product
changes are justified only when they also improve normal Artemis behavior — cancellation, usage
attribution, and observability. [docs/ARTEMIS-INTEGRATION.md](docs/ARTEMIS-INTEGRATION.md) defines
the lifecycle, state isolation, evidence, and the gates a formal run must pass.

## Telemetry and accounting

OpenTelemetry is the common process-evidence transport, not the global database of record. The
exgen ledger owns attempt identity and lifecycle, candidate/evaluator digests own outcome evidence,
product status attests product completion, and provider billing owns exact billed cost. Exgen
triangulates those claim-specific sources and fails closed on disagreement. Caches internal to a
generation system, such as Artemis Hazelcast, remain operational implementation details of that
system under test. Normalized telemetry evidence declares the profile `exgen.otel.genai.v3`; that
profile, the correlation contract, the privacy policy, and the completeness gates are defined in
[docs/TELEMETRY.md](docs/TELEMETRY.md). Private run evidence is packaged as a BagIt bag with
SHA-256 and SHA-512 manifests, described in
[docs/RESTRICTED-ARCHIVES.md](docs/RESTRICTED-ARCHIVES.md).

## Security

The command backend executes with the current user's permissions and is intended for trusted local
adapters. Formal runs require isolated execution and bounded resources. [SECURITY.md](SECURITY.md)
defines the trust boundaries and deployment baseline.
