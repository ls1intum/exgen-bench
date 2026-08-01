# Artemis integration design

> **Status:** accepted migration direction. The exgen adapter drives an ordinary full-stack Artemis
> deployment through the same production APIs as the instructor UI. Live deployment bootstrap
> automation and the independent evaluator suite remain to be completed before a formal campaign.
> The public Hyperion corpus is development data, not confirmatory evidence.

## Decision

Exercise generation is intentionally a full Artemis capability. It uses the database, LocalVC,
LocalCI, build agents, Hazelcast-backed job state, token budgets, repository persistence, and the
normal save and revert paths. Removing those dependencies for a benchmark would change the system
being measured.

Exgen therefore treats Artemis as a black-box system under test:

```text
exgen plan and ledger
        |
        v
external Artemis adapter -- normal authenticated production API --> full Artemis stack
        |                                                        DB / LocalVC / LocalCI
        |                                                        model and build agents
        v
immutable candidate and private evidence
        |
        v
independent evaluator in a separate environment
```

The adapter lives in this repository and implements generation protocol v2:

```bash
bun run adapters/artemis/adapter.ts describe --json
bun run adapters/artemis/adapter.ts generate --request REQUEST.json --output OUTPUT_DIRECTORY
bun run adapters/artemis/adapter.ts recover --request REQUEST.json --output OUTPUT_DIRECTORY
```

Artemis must not gain a benchmark controller, benchmark database tables, or benchmark-only
authorization. Production changes are acceptable only when they independently improve the product,
such as cancellation, bounded reconnect status, usage attribution, or structured observability.
The integration must not require an Artemis database migration.

A separate persistence-independent generation executable would be valuable only if Artemis itself
adopts that boundary for production. It is not a prerequisite for measurement.

## Ownership

| Concern | Owner |
| --- | --- |
| Dataset, schedule, attempt identity, budgets, retry policy | exgen |
| Course, exercise, repository, job, save, revert, and quota semantics | Artemis production |
| Mapping protocol requests to ordinary production API calls | exgen Artemis adapter |
| Database, LocalVC, LocalCI, Hazelcast, model and build-agent lifecycle | deployment bootstrap |
| Candidate artifact and operational-evidence capture | adapter and exgen |
| Hidden requirements, oracles, mutants and quality verdicts | independent evaluator |
| Statistical analysis and release provenance | exgen |

The database is part of the authentic runtime, not the benchmark control plane. The adapter uses
production APIs for live mutations. A version-pinned read-only extractor may collect evidence that
the product cannot expose, but it must verify the Artemis revision and migration set and must never
modify live tables.

## Production flow

For one attempt the adapter:

1. authenticates using credentials named by environment variable, never credentials embedded in a
   benchmark configuration;
2. creates a fresh unreleased exercise and empty repositories in the arm's dedicated course using
   normal production setup APIs and fixed campaign defaults;
3. creates the same empty draft exercise used by the UI and submits the visible brief to the normal
   whole-exercise generation endpoint;
4. records the returned generation job ID before polling;
5. polls the ordinary status endpoint for the internal specification Artemis calls the SPEC, plus
   progress events, file changes, terminal outcome, and cancellation state;
6. reads the persisted exercise metadata and template, solution, and test repositories through
   normal production APIs;
7. writes a protocol response and bounded diagnostic files; and
8. cancels or reconciles uncertain remote work during `recover`.

The source brief is the only case content visible to the system. Dataset extensions, hidden
requirements, evaluator assets, reference solutions, and mutants never enter Artemis.

The adapter parameters fix the production base URL, environment-referenced credentials, dedicated
course, exercise setup defaults, polling limits, and artifact bounds. Formal configuration must
additionally bind these parameters to the Artemis image/source revision, effective Spring profiles
and configuration, database migration set, LocalVC/LocalCI and build-agent images, model-serving
revision, and sandbox toolchain.

The checked-in campaign helper verifies an already provisioned course/account and guards optional
development cleanup:

```bash
bun run adapters/artemis/campaign.ts preflight --parameters PARAMETERS.json

bun run adapters/artemis/campaign.ts cleanup \
  --parameters PARAMETERS.json \
  --run-dir .exgen/runs/CAMPAIGN \
  --confirm-course-id COURSE_ID
```

Cleanup deletes only exercises whose exact ID and generated short name are recorded in adapter
state for that run. Formal deployment creation, baseline restoration, configuration attestation,
and teardown still need automated infrastructure outside Artemis.

## State and comparability

A database snapshot is useful for fast reset, but byte-identical databases are not the scientific
input: different Artemis revisions may require different schemas. The comparable input is a
versioned logical fixture replayed through production APIs. Before starting a pair, exgen must
digest the generator-visible exercise metadata and repository contents and reject the pair if they
differ.

Every attempt receives a fresh exercise and repositories. A dedicated course and editor account are
fixed within a study arm and contain no unrelated production data. Do not reproduce PECV-Bench's
`skipThreadContext`-style benchmark switch; isolate observations by state instead of changing
production semantics. Reset the deployment from a verified baseline between randomized blocks, or
prove that cumulative course/user quotas and retained state cannot affect later observations. The
concurrency rule in [METHODOLOGY.md](METHODOLOGY.md#experimental-design) applies here to Artemis
quotas, caches, LocalCI capacity, sandbox slots, and provider queues.

One disposable stack per attempt is unnecessarily expensive. The normal unit is one pinned stack
per generation system or randomized block, with unique attempt entities and a verified reset
between blocks. Systems must be interleaved or counterbalanced across time and host assignments.

## Evidence and telemetry

No single telemetry source is sufficient. Formal evidence has five layers:

| Layer | Required information | Role |
| --- | --- | --- |
| Exgen ledger | planned identity, lifecycle, schedule, budgets, hashes, recovery | source of record |
| Product transcript | job ID, internal SPEC, progress, file changes, terminal reason | user-visible behavior |
| Structured traces | model/tool/gate spans, requested and effective routing, usage, retries | causal diagnosis |
| Runtime attestation | source/image/SBOM, configuration, DB migrations, host, LocalVC/LocalCI, build agents | generation-system identity |
| Candidate and evaluation | immutable repositories, statement, verifier evidence, hidden-suite verdict | measured output |

Structured events should use contiguous sequence numbers and stable trace/span/parent IDs. Each
model call records its role, requested and effective model and parameters, provider request ID,
retry or fallback status, finish reason, usage, and input/output digests. Tool and gate spans record
arguments or bounded digests, result status, duration, and artifact references.

The ordinary terminal status response is the canonical aggregate accounting source. It exposes
`usage` (model-call and token counts, cache-read tokens, estimated cost, models, and provider response
IDs with independent completeness flags) together with `accountingComplete`. The adapter maps token
values into exgen accounting only when token completeness is
true; it only publishes cache-read tokens when that breakdown is complete, and never upgrades partial
provider IDs to complete. Traces diagnose individual calls but do not silently fill gaps in an
incomplete aggregate. An admitted provider attempt that ends in a transport/provider exception is an
accounting hole—not zero usage—because acceptance, provider-side work, or SDK retries cannot be ruled
out; Artemis therefore fails accounting closed for that job.

The adapter creates the same blank draft used by the production new-exercise flow and starts generation
with `{mode: "GENERATE", prompt: brief}`. This exercises Artemis's normal source-brief path rather than a
benchmark-only endpoint. The immutable exgen request and Artemis checkpoints preserve the submitted
brief; the generated final problem statement remains ordinary Artemis state. Unknown model prices,
cache reads without an attested cache price, and hidden provider retries make cost unverifiable, so the
adapter preserves complete token usage but omits canonical cost in those cases. Benchmark deployments
pin Spring AI provider retries to zero.

When—and only when—the entire generation system routes through OpenRouter, the adapter may reconcile every
complete provider response ID against OpenRouter's Generation API. It verifies native prompt,
completion, and cached-token totals against Artemis, sums provider-reported billed USD cost, and
stores the bounded response projection as digest-linked restricted evidence. Reconciliation fails
closed on missing or duplicate IDs, ledger disagreement, HTTP/schema errors, or missing credentials.
This provider-specific logic stays in exgen. Artemis remains provider-neutral and exposes correlation
IDs, token classes, and completeness-qualified configured EUR estimates only in the existing bounded
Hazelcast reconnect replay. The normal Artemis token-usage tables keep their existing schema; cache
pricing is blended into the existing input-cost field, and no benchmark migration or table is added.

Price catalogs such as OpenRouter's public model list, models.dev, and Artificial Analysis are
dated system-selection metadata. They can explain why a model was chosen, but they are not an
invoice and must not overwrite provider-reported billed cost. A no-billing deployment such as a
local Logos endpoint instead configures all relevant Artemis rates—including cached input—to
explicit zero. Missing configuration is unknown rather than free.

[OpenTelemetry GenAI conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/),
[W3C Trace Context](https://www.w3.org/TR/trace-context/), and
[Spring AI observability](https://docs.spring.io/spring-ai/reference/observability/index.html)
provide interoperable correlation. Sampled telemetry cannot replace the exgen ledger. The adapter
requires 100% sampling for benchmark runs and consumes the OTLP JSON emitted by a pinned standard
OpenTelemetry Collector. It identifies the job root by `artemis.hyperion.job.id`, selects the complete
trace by trace ID, verifies GenAI input/output usage against terminal product accounting, and retains
the bounded normalized trace as digest-linked restricted evidence. Preflight proves Artemis-to-
collector delivery with ordinary product requests. Missing, late, rotated, malformed, or
usage-inconsistent telemetry fails closed. The collector and consumer live in the benchmark
deployment and exgen; Artemis contains only production-useful Micrometer observations and standard
OTLP configuration. The formal adapter explicitly selects a restricted content tier using standard
`gen_ai.input.messages` and `gen_ai.output.messages`. Both must be present on every model call, and
the resulting prompt, completion, and tool content is encrypted/access-controlled operational
evidence. Credentials, hidden evaluator assets, and hidden chain-of-thought are never captured.

Protocol-v2 diagnostics remain separate from candidate identity. A job transcript or checkpoint
can explain an attempt, but it cannot silently resume an uncertain stochastic model call. Repeating
such a call is a new declared observation.

## Independent evaluation

Generation and evaluation are physically and temporally separate. Artemis may use its production
verifier and repair loop; those are part of the generation system. The hidden evaluator runs only after the
candidate has been frozen and cannot return feedback to Artemis.

The evaluator must support the open-ended nature of exercise generation. It uses brief-side atomic
requirements, multiple known-valid alternatives, requirement-targeted non-equivalent mutants, and
platform integrity checks rather than requiring one reference repository layout. A formal suite is
frozen and content-digested before collection, inaccessible from Artemis, and validated against
both valid alternatives and invalid sentinels.

## Failure and retry policy

[METHODOLOGY.md](METHODOLOGY.md#what-is-measured) defines failure attribution, the terminal
treatment of uncertain model calls, block replacement, and the evaluator retry rules. Two events are
specific to this integration:

| Event | Handling |
| --- | --- |
| Adapter loses contact while the bounded reconnect replay is available | recover by status lookup and cancellation |
| Full cluster restart or expired reconnect replay | invalidate the attempt; do not infer missing usage |

Artemis, its verifier, and its managed sandbox are part of the generation system, so their failures
are treatment-attributable rather than study-infrastructure failures. Unstarted or unresolved
attempts prevent a confirmatory release. They must not be converted into model-quality failures
merely because an operator stopped a campaign.

## Isolation and security

- Run a digest-pinned, disposable Artemis deployment with dedicated benchmark credentials and no
  production data.
- Give each study arm a dedicated course and editor account and each attempt a unique exercise and
  repository namespace.
- Keep generated-code sandboxes free of model, database, storage, and evaluator credentials.
- Keep hidden evaluator assets outside the Artemis network, database, images, logs, and mounts.
- Restrict model egress and record the effective endpoint and routing.
- Bound API bodies, logs, events, repository files, wall time, processes, memory, and disk.
- Encrypt private evidence, apply retention controls, and secret-scan it before publication.
- Use narrow cleanup credentials; never expose Docker sockets or host homes to generated code.

The baseline follows [NIST SP 800-190](https://csrc.nist.gov/pubs/sp/800/190/final), Docker's
[engine security guidance](https://docs.docker.com/engine/security/), and
[SLSA provenance](https://slsa.dev/spec/v1.2/provenance).

## Scientific acceptance gates

Before collection:

1. Freeze a timestamped registration with the sampling frame, case families, hypotheses, primary
   outcome, minimum meaningful effect, sample-size rationale, budgets, retry rules, concurrency,
   contrast, and stopping rule.
2. Keep public development, restricted validation, and sealed confirmatory families disjoint.
3. Resolve every generation-system and runtime component to an immutable manifest and prove per-call model
   routing with no silent fallback.
4. Prove equal generator-visible fixtures across paired systems.
5. Validate the evaluator on all vetted alternatives and critical invalid sentinels, and meet a
   preregistered mutant-sensitivity threshold.
6. Demonstrate zero cross-attempt state, quota, artifact, or hidden-suite leakage at the intended
   concurrency.

Before a confirmatory release:

1. every planned attempt is terminal, every pair is complete, and every generated candidate has an
   independent verdict;
2. no study or evaluator infrastructure failure remains unresolved;
3. no generation-system, fixture, routing, suite, or environment drift occurred;
4. every claimed success has complete budget evidence;
5. exclusions, invalidated blocks, replacements, retries, and missingness are disclosed; and
6. analysis resamples semantic case families and bounds claims to the registered sampling frame.

The 19-case Hyperion pack is public development data. Repetitions estimate within-case
stochasticity; they do not increase the number of independent case families. A strong-planner /
weak-executor claim requires a preregistered factorial design and interaction analysis rather than
selective pairwise comparisons.

## Migration and Playwright removal

1. Keep the former live briefs and outcomes as public development fixtures.
2. Complete the external production-API adapter with deterministic contract tests for setup,
   status replay, extraction, cancellation, recovery, and malformed or partial responses.
3. Automate a digest-pinned disposable Artemis stack and logical baseline provisioning.
4. Add generation-system and environment attestation and typed call/tool/gate telemetry.
5. Build and validate the restricted independent evaluator suite.
6. Run a live canary, then dual-run the browser harness and exgen on frozen development cases.
   Reconcile requests, generator-visible fixtures, terminal outcomes, artifacts, events, usage, and
   failures.
7. Require two consecutive campaigns with complete evidence and no unexplained gaps.
8. Remove only the stochastic live-LLM Playwright quality harness. Retain a small mocked UI wiring
   test and an API-driver parity canary.

The design reuses the central strength of
[PECV-Bench](https://github.com/ls1intum/PECV-bench)—evaluating the real Artemis application—without
copying its mutable dependency pulls, manual model labels, persistent shared state, or
benchmark-specific production switch. It also addresses checkpoint and sandbox drift reported in
[Inspect #4601](https://github.com/UKGovernmentBEIS/inspect_ai/issues/4601) and
[SWE-bench #602](https://github.com/SWE-bench/SWE-bench/issues/602).
