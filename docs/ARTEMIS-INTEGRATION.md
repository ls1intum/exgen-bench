# Artemis integration design

> **Status:** experimental and partially realised. The adapter targets the unmerged Artemis branch
> documented in its [upstream compatibility table](../adapters/artemis/README.md#upstream-status).
> It drives ordinary product APIs without benchmark tables or database migrations. Deployment
> attestation, quota isolation, bootstrap automation, and the independent evaluator remain
> incomplete, so the public Hyperion corpus is development data rather than confirmatory evidence.

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

## Current limitations

Artemis accepts an admin-defined effort profile plus per-request token and duration ceilings, but
attests only the resolved profile name. The adapter therefore exposes `effort_profile` as a factor
and keeps the unattested ceilings as parameters. The remaining study limitations are:

| Gap | Consequence |
| --- | --- |
| A rolling per-user token admission quota | Later attempts share less allowance than earlier attempts, coupling a campaign over time. |
| The status carries no effective limit values | Configured limits cannot support a `non_binding` budget verdict. |
| No build revision or profile-content attestation | A changed build or redefined profile can leave the attestation digest unchanged. |
| No complete accounting on an incomplete seal | With no complete usage there is nothing for the telemetry cross-check to reconcile against, so the audit does not run where it is most needed. |
| No validated independent evaluator or deployment bootstrap | A live adapter run is development evidence, not an end-to-end quality comparison. |

The product-facing remedies are revision and profile-content attestation, effective limit reporting,
and remaining-allowance reporting for admission quotas. Each improves normal product operations;
none requires benchmark-only storage or a database migration.

The adapter README is the source of truth for
[campaign setup](../adapters/artemis/README.md#campaign-setup) and
[deployment limits](../adapters/artemis/README.md#artemis-limits-that-shape-a-campaign). The generic
criteria for deciding which study designs those capabilities support remain in
[SUT-REQUIREMENTS.md](SUT-REQUIREMENTS.md).

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
revision, and sandbox toolchain — a binding the deployment cannot yet attest to
([R6](SUT-REQUIREMENTS.md#r6--configuration-attestation)).

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
versioned logical fixture replayed through production APIs. Before starting a pair, exgen would have
to digest the generator-visible exercise metadata and repository contents and reject the pair if
they differ. No such check exists — see
[METHODOLOGY.md § Not yet enforced](METHODOLOGY.md#not-yet-enforced).

Every attempt receives a fresh exercise and repositories. A dedicated course and editor account are
fixed within a study arm and contain no unrelated production data. Do not reproduce PECV-Bench's
`skipThreadContext`-style benchmark switch; isolate observations by state instead of changing
production semantics. Reset the deployment from a verified baseline between randomized blocks, or
prove that cumulative course/user quotas and retained state cannot affect later observations. The
concurrency rule in [METHODOLOGY.md § Not yet enforced](METHODOLOGY.md#not-yet-enforced) applies
here to Artemis quotas, caches, LocalCI capacity, sandbox slots, and provider queues. Artemis's
rolling per-user admission quota couples attempts across time on its own, so serial execution does
not by itself make them independent.

One disposable stack per attempt is unnecessarily expensive. The normal unit is one pinned stack
per generation system or randomized block, with unique attempt entities and a verified reset
between blocks. Systems must be interleaved or counterbalanced across time and host assignments.
Two arms differing only by effort profile can now share one deployment, so interleaving is
reachable; what is not yet established is that the shared admission quota, build agents, and
sandbox slots leave the arms independent.

## Evidence and telemetry

No single telemetry source is sufficient. Formal evidence has five layers:

| Layer | Required information | Role |
| --- | --- | --- |
| Exgen ledger | planned identity, lifecycle, schedule, budgets, hashes, recovery | source of record |
| Product transcript | job ID, internal SPEC, progress, file changes, terminal reason | user-visible behavior |
| Structured traces | model/tool/gate spans, requested and effective routing, usage, retries | causal diagnosis |
| Runtime attestation | source/image/SBOM, configuration, DB migrations, host, LocalVC/LocalCI, build agents | generation-system identity |
| Candidate and evaluation | immutable repositories, statement, verifier evidence, hidden-suite verdict | measured output |

Layers one, two, three, and five are captured today. The runtime-attestation layer is not: nothing
queries an Artemis revision or effective configuration, and the declared revision is a literal
string in the adapter and the benchmark configuration.

Structured events should use contiguous sequence numbers and stable trace/span/parent IDs. Each
model call must record its role, requested and effective model and parameters, provider request ID,
retry or fallback status, finish reason, usage, and input/output digests; Artemis reports the
provider request ID, usage, finish reason, and model identity, and reports no effective decoding
parameters. Tool and gate spans record
arguments or bounded digests, result status, duration, and artifact references.

The ordinary terminal status response is the aggregate accounting source. Its `accountingState` is
`PENDING`, `COMPLETE`, or `INCOMPLETE`: the adapter waits only on `PENDING`, publishes usage only from
`COMPLETE`, and treats `INCOMPLETE` as a permanent gap. Provider-request-ID and token-breakdown
completeness remain independent. Traces diagnose individual calls but never fill gaps in an
incomplete product aggregate.

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

OpenRouter catalog pricing can additionally produce a dated reference estimate for a local or
otherwise unbilled model. It is stored separately from canonical provider cost, never participates
in budget compliance, and carries the quote, raw-response digests, retrieval timestamps, exact
decimal rates, assumptions, and active-route range. The full provenance and failure rules are in
[Reference pricing](REFERENCE-PRICING.md). A no-billing deployment still reports its actual billed
cost as explicit zero when it can attest that claim; a reference estimate is not an invoice.

[OpenTelemetry GenAI conventions](https://github.com/open-telemetry/semantic-conventions-genai),
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

Follow the repository [security policy](../SECURITY.md) and
[restricted-archive controls](RESTRICTED-ARCHIVES.md). Artemis runs in a disposable deployment with
no production data, dedicated credentials and courses, restricted model egress, and no evaluator
assets. Generated-code sandboxes receive no model, database, storage, or evaluator credentials.

## Scientific acceptance gates

The [methodology](METHODOLOGY.md) defines the registration and release gates. An Artemis comparison
additionally needs immutable build, profile, routing, and fixture attestations; no cross-attempt
state or quota interference; and an independent evaluator outside the Artemis deployment. The
19-case Hyperion pack remains development data. A planner/executor comparison requires a
preregistered factorial design rather than selective pairwise comparisons.

## Migration and Playwright removal

1. Keep the former live briefs as public development fixtures.
2. Automate a digest-pinned disposable Artemis stack and logical baseline provisioning.
3. Add build, profile-content, routing, and environment attestation.
4. Build and validate the restricted independent evaluator suite.
5. Run a live canary, then dual-run the browser harness and exgen on frozen development cases.
   Reconcile requests, generator-visible fixtures, terminal outcomes, artifacts, events, usage, and
   failures.
6. Require two consecutive campaigns with complete evidence and no unexplained gaps.
7. Remove only the stochastic live-LLM Playwright quality harness. Retain a small mocked UI wiring
   test and an API-driver parity canary.

Like [PECV-Bench](https://github.com/ls1intum/PECV-bench), this design evaluates the real Artemis
application. The adapter and evidence pipeline remain outside Artemis, and Artemis gains no
benchmark-only production switch.
