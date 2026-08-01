# Hyperion development study

Both configurations run the 19-case
[Hyperion development pack](../../datasets/hyperion-development-v1/README.md). Both are single-arm
and descriptive: they estimate one generation system's exercise success rate with a case-clustered
bootstrap. Neither declares a contrast, because there is only one arm to compare.

## Smoke configuration

`benchmark.smoke.yaml` is executable now. It runs the deterministic fixture generator over all 19
cases and exercises dataset loading, planning, generation, evidence capture, and release-ready
attempt records:

```bash
bun run cli validate studies/hyperion-development/benchmark.smoke.yaml
bun run cli run studies/hyperion-development/benchmark.smoke.yaml --id smoke-1
```

Generation succeeds 19/19. The configuration declares no evaluator, so it does not exercise
evaluation — that is a separate command with its own configuration
([process evaluators](../../docs/PROCESS-EVALUATORS.md)). A clean run never enters a resumable
state either, so it does not exercise resume; re-running with the same ID fails with `EEXIST`.

## Live configuration

`benchmark.full-stack.template.yaml` defines the live generation system through the external
Artemis production-API adapter. It requires a normally configured full Artemis deployment with
`core`, `localci`, `localvc`, Hyperion exercise generation, a model endpoint, build agents, a
dedicated benchmark course, and environment-provided editor credentials. Before a live run:

```bash
export EXGEN_ARTEMIS_ADAPTER_ID=artemis # must exactly match this system's systems[].id
export ARTEMIS_BENCHMARK_USERNAME=...
export ARTEMIS_BENCHMARK_PASSWORD=...
```

1. replace every placeholder revision, URL, course ID, and fixture default;
   use a separate system entry (and matching adapter ID) for every arm;
2. pass credentials through the declared environment-variable mapping, never the YAML file;
3. record the Artemis, database migration, LocalVC, LocalCI, build-agent, sandbox, model-serving,
   prompt, and effective configuration digests;
4. restore a verified logical baseline and give every attempt fresh exercise/repository state;
5. freeze routing, toolchain, budget, evaluator suite, retry policy, concurrency, and seeds;
6. run `exgen validate` and archive the resolved `exgen plan --json`;
7. evaluate every frozen candidate with an independent pinned verifier; and
8. label results descriptive, because this public corpus is a development set.

The production API flow, evidence layers, and formal acceptance gates are specified in
[`docs/ARTEMIS-INTEGRATION.md`](../../docs/ARTEMIS-INTEGRATION.md). The failure, retry, concurrency,
and registration rules that govern the run are in
[`docs/METHODOLOGY.md`](../../docs/METHODOLOGY.md).

Steps 3 to 5 are manual: no code records a deployment attestation, restores a verified baseline, or
compares a generator-visible fixture across attempts. Artemis reaches conformance level 1 of
[`docs/SUT-REQUIREMENTS.md`](../../docs/SUT-REQUIREMENTS.md), so this template stays single-arm —
not because a second arm cannot be configured, but because it would not yet measure. A second arm is
now a configuration change: add a system whose `effort_profile` factor names a different
admin-defined profile on the same deployment. What still blocks the result is the rolling admission
quota, the absence of any `system_reported` limit, and an attestation that cannot see inside a
profile.

### Precision

19 cases at one replicate estimate a rate to roughly ±20 percentage points, and cannot support a
comparison of anything smaller than about a third of the outcome scale. Declare the smallest
meaningful effect before running, and check it against
[`docs/METHODOLOGY.md`](../../docs/METHODOLOGY.md#statistical-scale).

### Feasibility and stopping

19 cases × 3 replicates = 57 attempts. At the `execution.concurrency: 1` the template declares — a
value nothing in the runner enforces — and the declared `wall_time_ms: 3600000`, the worst case is
57 hours of continuous serial execution. The expected
wall clock depends entirely on the deployment and has not been measured here, so the first task
before scheduling a live run is a pilot of a few attempts to obtain a median duration; a run that is
scheduled on the worst case alone will be abandoned halfway.

The template declares no stopping rule, and one must be added to the registration before use.
`docs/ARTEMIS-INTEGRATION.md` requires a stopping rule in the frozen registration, and a run
abandoned without one produces unstarted attempts that stay in the denominator and block a
confirmatory release.

### Budgets

The template declares only the wall-time budget. Add call, token, or cost budgets only when the
deployed Artemis status endpoint reports `accountingComplete: true` for every terminal job. The
adapter maps complete status usage into exgen's canonical accounting fields; incomplete accounting
makes a strict resource-budget outcome unverifiable. Artemis's effective internal token and quota
policy remains part of the system manifest.

Planner and executor model assignments are explicit factors of the generation system. A future
strong-planner / weak-executor comparison should be a predeclared 2×2 factorial with fresh paired
attempts, a fixed orchestration and evaluator, role-level call/cost evidence, and interaction
analysis. Do not silently route, retry, or fall back between models.

## Seeds

Each configuration uses two distinct seeds so the schedule and the resampling draw are independent,
and so the smoke and live studies do not share a draw. Each is the first eight hex digits of
`sha256("exgen-bench/<config id>/<purpose>")` read as an unsigned 32-bit integer:

| Configuration | `trials.base_seed` | `analysis.bootstrap_seed` |
| --- | --- | --- |
| `hyperion-development-smoke` | 497506175 | 2946802029 |
| `hyperion-development-live` | 3338702608 | 150218520 |
