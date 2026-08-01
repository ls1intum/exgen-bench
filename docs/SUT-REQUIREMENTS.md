# System-under-test requirements

What a generation system must support — in itself or through its adapter — before exgen-bench can
measure it. Requirements are graded into three conformance levels, so a system can be described
honestly as partially benchmarkable. The [glossary](GLOSSARY.md) defines the project terms used
here. This document is reference; the reasoning behind the level structure is confined to
[Why levels](#why-levels) at the end.

## Scope

A requirement here is a property of the [system under test](GLOSSARY.md#system-under-test), not of
the harness. Some can be satisfied by an [adapter](GLOSSARY.md#adapter) on the system's behalf: an
adapter can create a fresh exercise per attempt, but it cannot make a server-wide setting
per-request. Every requirement states which.

Requirements are stated per level, and each level includes every requirement below it. A system's
level is the highest level whose requirements it fully meets. A system that meets some Level 2
requirements and not others is Level 1; the requirements it does meet are listed separately rather
than rounded up.

Two things this document does not cover, because they are properties of a study rather than of a
system: the independent [evaluator](GLOSSARY.md#evaluator) suite, and the
[registration](GLOSSARY.md#registration) that freezes a design before collection. Both are in
[METHODOLOGY.md](METHODOLOGY.md).

### What each level unlocks

| Level | Attained when | Designs it supports | Designs it does not support |
| --- | --- | --- | --- |
| 0 Unmeasured | — | none | any published rate |
| 1 Observable | R1–R5 | a single-arm descriptive rate over generation outcomes, with every planned attempt terminal | any resource claim; any comparison |
| 2 Accountable | R6–R11 | `end_to_end_within_budget_strict_success_rate` with a resource-compliance condition that can actually fail; drift detection across a campaign; a measurable statement about non-reproducibility | any comparison |
| 3 Comparable | R12–R14 | `..._difference` between two arms, randomized blocks with interleaved arms, pairing on the case | claims beyond the declared [sampling frame](GLOSSARY.md#sampling-frame) |

An [exercise success rate](GLOSSARY.md#exercise-success-rate) additionally needs an independent
evaluator, which no level supplies: a Level 1 system without one yields a generation-outcome rate,
which is a different quantity and must be labelled as one.

### Dependency rule

A study may not declare a design that depends on a requirement above the level its systems attain.
Doing so may produce records, but not the estimand the design names.

### Verification status

Each requirement carries the status of the strongest check that exists today.

- **Enforced** — checked-in code fails the attempt, the run, or the release when the requirement is
  unmet.
- **Recorded** — a value reaches the run record and no rule consults it. A violation is visible to a
  reader and to nothing else.
- **Declared** — asserted in configuration or prose; nothing reads it back.

The status is part of the requirement. An unverified requirement is a wish, and a benchmark that
counts wishes as controls reports a confounded number with a confident interval around it.

A check that cannot fail is not a check. When judging a status below, ask what observation would
move it.

## Level 1 — Observable

Attained when the harness can obtain one attempt's outcome and know that it is terminal, complete,
and not silently resampled.

### R1 — Brief-only request

- **Requirement.** The system accepts an [exercise brief](GLOSSARY.md#exercise-brief) as the only
  case-derived input and starts exactly one generation from it. No part of the case may reach the
  system by another route.
- **Scope.** Per request.
- **Blocks without it.** The case stops being the treatment input. If any case-specific material is
  configured into the deployment, the dataset is no longer the only thing that varies across
  attempts, and the case-clustered bootstrap resamples a unit that is not the unit that varied.
- **System satisfies it by.** Accepting free text on the same endpoint an ordinary user submits to.
- **Adapter satisfies it by.** Mapping the brief onto native fields. It may add fixed campaign
  defaults, never case-derived content.
- **Verification.** *Recorded.* The harness writes the immutable request and digests it into the
  attempt's evidence manifest; it does not observe what the adapter forwarded.

### R2 — Terminal state, with "never" distinguishable from "not yet"

- **Requirement.** Every started generation reaches exactly one terminal state, and the system's
  status interface distinguishes *still running* from *finished* and reports why it finished.
- **Scope.** Per request.
- **Blocks without it.** The planned-attempt denominator. An attempt that can be neither resumed nor
  declared dead stays unresolved, and an unresolved attempt blocks a confirmatory release
  permanently — it cannot be dropped without changing the denominator, and it cannot be counted.
- **System satisfies it by.** A status resource carrying a running flag, a terminal event, and a
  termination reason.
- **Adapter satisfies it by.** Mapping onto the four protocol states `succeeded`, `failed`,
  `abstained`, `infra_failed`. It may not invent a terminal state for a system that has not reached
  one.
- **Verification.** *Enforced.*
  [`schemas/protocol/generation-response.schema.json`](../schemas/protocol/generation-response.schema.json)
  rejects a response without a terminal status, and the runner marks an attempt it cannot resolve
  `interrupted` rather than resampling it.

### R3 — Candidate and evidence export

- **Requirement.** The complete [candidate exercise](GLOSSARY.md#candidate-exercise) is readable
  back out through a stable interface after generation, at a revision identity that pins exactly
  what was generated, and the system reports whether that export is complete or partial.
- **Scope.** Per attempt.
- **Blocks without it.** Out-of-process evaluation. The evaluator runs after the candidate is frozen
  and never talks to the system; without export there is nothing to freeze, no candidate digest, and
  no evaluation identity.
- **System satisfies it by.** Read APIs for the statement, starter code, reference solution, tests
  and platform metadata, plus a version or commit identity for each.
- **Adapter satisfies it by.** Downloading and packaging them, and cross-checking the exported
  contents against the revision identity the system reported.
- **Verification.** *Enforced.* Every declared artifact path is validated and digested
  (`src/adapters/artifacts.ts`), a `succeeded` response must declare at least one artifact, and the
  candidate digest enters the evaluation identity. Partial export is declared through
  `capture.completeness`, which the schema constrains but no rule consults — see R8.

### R4 — Cancellation and recovery

- **Requirement.** A running generation can be cancelled, and its terminal state can be looked up by
  an identifier that outlives the connection, the adapter process, and the harness process.
- **Scope.** Per request.
- **Blocks without it.** The rule that an uncertain model call is terminal and is never silently
  replayed. Without cancellation an interrupted attempt either leaks server-side work into a later
  attempt or gets resampled, and a resampled stochastic call is a new observation with a different
  outcome distribution.
- **System satisfies it by.** Returning a job identifier before work begins, exposing a cancel
  operation, and keeping status queryable after the client disappears.
- **Adapter satisfies it by.** Implementing `recover`, which cancels and reconciles but never starts
  a second sample, and refusing to adopt a job it did not start.
- **Verification.** *Enforced.* The runner consults the `crash_recovery` capability, invokes the
  adapter's `recover` command, and leaves the attempt unresampled when cancellation cannot be
  confirmed (`src/core/run.ts`).

### R5 — Fresh state per attempt

- **Requirement.** Each attempt operates on freshly created logical entities, and nothing an attempt
  writes is readable by a later attempt.
- **Scope.** Per attempt.
- **Blocks without it.** Treating attempts as observations at all. A system that reads its own
  previous output makes the second attempt on a case conditional on the first, which is neither the
  independence the bootstrap assumes nor the [repetition](GLOSSARY.md#repetition-and-replicate) the
  plan declares.
- **System satisfies it by.** Namespaced entity creation with no shared mutable store keyed by user
  or course.
- **Adapter satisfies it by.** Creating a fresh entity and empty repositories per attempt, and
  restoring a verified baseline between randomized blocks. This is the strongest example of a
  requirement an adapter can carry for a system that has no notion of a benchmark.
- **Verification.** *Declared.* Nothing in the harness digests a generator-visible fixture or
  compares it across attempts; see [METHODOLOGY.md § Not yet
  enforced](METHODOLOGY.md#not-yet-enforced). Verifying it would require the adapter to report a
  fixture digest that the runner compares within a block.

## Level 2 — Accountable

Attained when the record says what actually ran, under which limits, at what cost, and how much of
the outcome is attributable to sampling noise.

### R6 — Configuration attestation

- **Requirement.** The system reports what actually served the request: build or source revision,
  model identity, effective decoding parameters, effective resource limits, and any value the
  benchmark declared that the system overrode or ignored. The distinction that matters is
  **accepting** a setting versus **attesting** it. A system that accepts a ceiling and never echoes
  it leaves the benchmark holding the adapter's word; only what the system reports back can carry a
  claim. R6 is the attesting half, R14 is the per-attempt binding of it, and a setting that is
  accepted but not attested may be a parameter but never a factor.
- **Scope.** Per deployment at minimum; per attempt once R12 exists, because a per-request setting
  needs a per-request receipt.
- **Blocks without it.** Reproducibility and drift detection together. Without a machine-readable
  receipt, a configuration change in the middle of a campaign is invisible: the affected block
  cannot be identified, so it cannot be invalidated and replaced, so the whole campaign is suspect
  rather than the block.
- **System satisfies it by.** An endpoint returning its revision and its effective
  generation-relevant configuration, and echoing the same values on the terminal status of each job.
- **Adapter satisfies it by.** Reading that endpoint and placing the values in
  `execution.effective_parameters`. It cannot substitute for the system: a hand-written revision
  string in an adapter or a benchmark configuration attests to the author's intention, not to the
  deployment.
- **Verification.** *Enforced, partially.* The runner digests `execution.effective_parameters` and
  `execution.effective_limits` per attempt and fails a later attempt under the same requested
  system, adapter parameters, factors, and target whose digest differs, with
  `generator.attestation_mismatch`; a system declares any intended change under
  `attestation.deployment_deviations`. Not yet enforced: that the attestation is non-empty, or that
  it names a build revision — a system reporting `{}` on every attempt is self-consistent and
  passes.

### R7 — Budget delegation

- **Requirement.** The system either accepts the benchmark's declared [resource
  limits](GLOSSARY.md#resource-limits) and honours them, or reports its own effective limits so the
  binding ceiling is recorded.
- **Scope.** Per request for acceptance; per deployment is sufficient for reporting.
- **Blocks without it.** The `within_budget` leg of the declared estimand. If the system's own
  ceilings bind first, "the attempt stayed within its resource limits" is a statement about a limit
  that was never approached.
- **System satisfies it by.** Accepting per-request ceilings, or exposing its configured ceilings
  and naming which one terminated a job.
- **Adapter satisfies it by.** Forwarding declared ceilings where the API accepts them, and
  reporting the system's own ceilings so the plan can be written against the effective budget rather
  than a decorative one.
- **Verification.** *Enforced.* `budget.enforcement` names the harness or the system as the enforcer
  of each dimension, and preflight rejects a system whose declared `budget_dimensions` cannot cover
  a dimension assigned to it. The runner enforces `wall_time_ms` by aborting the attempt and grades
  every dimension against both the declared limit and the system's reported `effective_limits`:
  `compliant`, `non_binding` when the system's own limit is tighter, `unverifiable` when the plan
  declared nothing or the adapter reported nothing, `exceeded` otherwise. Each effective limit
  carries a `source`, and `non_binding` is granted only from `system_reported`. That verdict is the
  claim *the system's own guard bound first*, and only the system can support it. A
  `system_configured` or unsourced value is still recorded, and still cannot earn the verdict. The
  attempt takes the worst of them, and only `compliant` and `non_binding` reach a
  [strict success](GLOSSARY.md#strict-success), so an undeclared dimension costs the attempt rather
  than passing it.

### R8 — Usage accounting that cannot disable its own audit

- **Requirement.** The system reports usage together with an explicit completeness flag, and
  incomplete accounting never decides whether a verification runs. Incompleteness suppresses the
  *claim*, not the *check*.
- **Scope.** Per attempt.
- **Blocks without it.** Every cost and token claim, and worse, silently. A completeness flag that
  gates its own cross-check is a control that switches itself off exactly in the cases where it is
  needed; the resulting evidence is complete wherever it was verified and unverified wherever it was
  incomplete, which reads as clean data.
- **System satisfies it by.** Publishing usage, per-class completeness flags, and provider
  correlation identifiers as separate fields, and failing accounting closed for a job whose provider
  attempt ended in an exception rather than reporting zero.
- **Adapter satisfies it by.** Mapping usage into canonical fields only when the corresponding
  completeness flag is true — and still running the independent cross-check when it is false, so the
  gap is measured rather than assumed.
- **Verification.** *Recorded.* `capture.completeness` is constrained by the response schema (a
  response with `completeness: "none"` may not declare artifacts) and is read by nothing downstream;
  `provider_request_ids_complete` is exported as a column and consulted by nothing.

### R9 — Process observability

- **Requirement.** The system emits OpenTelemetry spans for its model calls under the GenAI semantic
  conventions, at 100% sampling for a benchmark run, with model content capture available and off
  unless explicitly selected.
- **Scope.** Per deployment for the exporter; per model call for the spans.
- **Blocks without it.** Independent verification of the system's own accounting, and every
  treatment-fidelity question — whether the model that answered is the model the arm declares,
  whether a retry or a fallback occurred, which call consumed the budget. Product status attests
  completion; it cannot attest routing.
- **System satisfies it by.** Standard instrumentation and standard OTLP configuration. Nothing
  benchmark-specific: the GenAI conventions and W3C Trace Context are the interoperable surface, and
  a system that has them for its own operators has them for a benchmark.
- **Adapter satisfies it by.** Consuming the collector's output, selecting the attempt's trace,
  reconciling span usage against terminal product accounting, and failing closed on disagreement. It
  cannot create spans a system does not emit.
- **Verification.** *Enforced by the adapter, not by the runner.* The profile, completeness gates
  and content-tier rules are in [TELEMETRY.md](TELEMETRY.md); the runner does not consult telemetry
  when it accepts an attempt.

### R10 — Independence across attempts over time

- **Requirement.** Either no state carries from one attempt to the next, or every carrying mechanism
  is disclosed with its window and its reset procedure. Rolling usage quotas, failure cooldowns,
  warm caches, and JIT warm-up all count.
- **Scope.** Per deployment.
- **Blocks without it.** The claim that attempts are exchangeable within a case, which both the
  single-arm and the paired bootstrap need. This is the requirement most often assumed away:
  **concurrency one does not deliver it.** Serial execution removes contention; it does not remove a
  24-hour rolling token quota, a cooldown after a failure, or a cache that is cold for case 1 and
  warm for case 19. The coupling is temporal, not concurrent, and running slower makes some of it
  worse.
- **System satisfies it by.** Making quota windows, cooldowns and caches configurable or resettable,
  and reporting the remaining allowance so a campaign can be scheduled around it rather than into
  it.
- **Adapter satisfies it by.** Restoring a verified baseline between randomized blocks and refusing
  to start a block whose remaining allowance cannot cover it. It cannot remove the coupling.
- **Verification.** *Declared.* `execution.concurrency` defaults to 1 and accepts any positive
  integer; no code enforces the value, and no code models a quota window.

### R11 — Determinism evidence

- **Requirement.** Record enough that non-reproducibility is measurable. The requirement is not that
  the system be reproducible.
- **Scope.** Per attempt.
- **Blocks without it.** Any attribution of a difference between two runs. Without the effective
  decoding parameters, the model and serving revision, and a provider-side correlation identifier
  per call, a changed outcome cannot be assigned to the treatment, to a configuration change, or to
  sampling.
- **Honest baseline.** Most providers do not guarantee reproducibility even at temperature zero.
  Thinking Machines Lab traced the residual variation to the batch-size dependence of reduction
  kernels: a request's output depends on the batch it was scheduled into, and the batch depends on
  the load the endpoint happened to be under, so bit-exactness is unattainable on a shared endpoint
  regardless of the sampling parameters. It is attainable with batch-invariant kernels, at a
  throughput cost. A benchmark should therefore require the *record*, and treat a system that
  additionally offers bit-exactness as exceeding this requirement.
- **System satisfies it by.** Reporting the effective sampling parameters, model and serving
  revision, and a provider response identifier for every call; honouring a requested seed is an
  optional capability, not this requirement.
- **Adapter satisfies it by.** Reporting `execution.effective_parameters`, `provider_request_ids`
  and their completeness flag, and setting `seed_status` honestly.
- **Verification.** *Recorded, with a consistency check.* `seed_status`,
  `effective_parameters_digest`, `provider_request_ids_digest` and `provider_request_ids_complete`
  are stored and exported, and the runner rejects a `seed_status` that contradicts the adapter's
  declared seed capability. Nothing currently verifies a claimed `honored` seed by replaying it.

## Level 3 — Comparable

Attained when two arms can run inside one campaign, so that a difference between them is not also a
difference in deployment.

### R12 — Per-request configuration selection

- **Requirement.** Every factor that defines an arm — model, decoding parameters, turn or step caps,
  staging mode, context window, prompt or workflow version — is selectable per request.
- **Scope.** Per request. This is the level's defining requirement and the one an adapter cannot
  carry.
- **Blocks without it.** Every comparative design in [METHODOLOGY.md § Experimental
  design](METHODOLOGY.md#experimental-design). Two arms cannot coexist in one deployment, so each
  arm needs its own deployment, so the treatment is perfectly confounded with deployment epoch,
  wall-clock window, JIT and cache state, and provider load. Block shuffling and system-order
  shuffling still run; they randomize an order that no longer separates the arms.
- **System satisfies it by.** Either a request field per factor, or — the better product shape — a
  set of **named configurations**: the system publishes identified bundles of settings under an
  endpoint a caller can list, and the request selects one by name. Build this one. Administrators
  define what is runnable and users select among those definitions, so the surface stays small, the
  arm identity is a first-class product object rather than a bag of benchmark parameters, and it is
  far easier to attest under R6 than free-form overrides. A free-form model or decoding parameter is
  also a cost and abuse vector, and it lets a caller configure the system into a state no instructor
  would ever run — which is not a treatment anyone wants to compare against.
- **Adapter satisfies it by.** Nothing. An adapter can only pass through what the API accepts; a
  server-wide setting is a server-wide setting. Rebinding a deployment between arms is not
  satisfaction of this requirement, it is the confound it exists to prevent.
- **Verification.** *Enforced up to the system's own word.* The generation request carries the
  arm's `requested` factors, a multi-arm configuration must declare at least one `requested` or
  `observed` factor whose value differs across arms, and a factor the system reports differently
  from the declaration fails the attempt. An adapter declares two independent lists — `controls`,
  the factors it can apply, and `observes`, the factors it can attest — and preflight refuses a
  study naming a factor absent from the relevant list, before any network round trip. The lists are
  separate because the asymmetry is real: a system may apply a setting it never echoes back, and
  such a setting rests on the adapter's word alone. Factor names are bare snake_case on every
  surface, so the configuration, the request, the capability and the response cannot drift into four
  spellings. What no harness can check is whether a system that echoes a factor back actually
  applied it — which is why R12 is a requirement on the system rather than on the protocol.

### R13 — Arm co-residency

- **Requirement.** Two arms can be served by one deployment concurrently or in interleaved order,
  without either arm's traffic changing the other's behaviour.
- **Scope.** Per deployment.
- **Blocks without it.** Interleaving and counterbalancing, which is what makes randomized block
  order worth computing. Co-residency also inherits R10: two arms sharing one rolling quota are
  coupled even when they run one at a time.
- **System satisfies it by.** Per-request configuration resolution with no cross-request caching
  keyed on a previous request's configuration, and quota accounting that a study can scope per arm.
- **Adapter satisfies it by.** Nothing, beyond declining to start a block it cannot isolate.
- **Verification.** *Declared.* Nothing models a shared quota window or detects one arm's traffic
  in another arm's results.

### R14 — Per-attempt configuration binding

- **Requirement.** The attestation of R6 is returned per attempt and names which configuration
  actually served it, so a mismatch between the declared arm and the serving configuration is
  detectable on the attempt that suffered it.
- **Scope.** Per attempt.
- **Blocks without it.** Block invalidation, which is the study's only remedy for drift. A campaign
  that can detect a configuration change only at deployment granularity must invalidate everything
  or nothing.
- **System satisfies it by.** Echoing the selected configuration name or digest on the terminal
  status of the job.
- **Adapter satisfies it by.** Comparing that value against the arm the request declared and failing
  the attempt on disagreement — the same fail-closed pattern the telemetry reconciliation already
  uses.
- **Verification.** *Enforced.* A `requested` or `observed` factor missing from, or disagreeing
  with, `execution.observed_factors` fails the attempt with `generator.attestation_mismatch`, and
  preflight has already refused any factor the adapter did not declare under `observes`. A setting
  the system accepts but does not attest cannot reach this check at all, and so cannot be a factor.

## Optional capabilities

Claimed and verified separately from the levels, because they are useful and orthogonal rather than
prerequisite. A system may hold any of them at any level.

| Capability | Requirement | Verification |
| --- | --- | --- |
| Seed honouring | The system accepts a requested seed, honours it, and returns the effective seed. Reported as `seed_status: "honored"` with a matching `effective_seed`. | *Recorded.* The response schema requires the effective seed to match when `honored` is claimed; nothing tests the claim by replaying. |
| Billed-cost attestation | The system or its provider reports billed cost for the attempt's calls. A dated price catalogue is system-selection metadata and must not overwrite a provider-reported amount; an unpriced deployment configures explicit zero rather than leaving cost unknown. | *Recorded.* `cost` is compared against `max_cost` when the plan declares one. |
| Model content capture | The system can emit `gen_ai.input.messages` and `gen_ai.output.messages`, off unless explicitly selected, with credentials, hidden evaluator assets and hidden reasoning never captured. | *Enforced by the adapter* under the content tier in [TELEMETRY.md](TELEMETRY.md). |

## Why levels

*Explanation. Nothing in this section is normative.*

The level scheme is modelled on [SLSA](https://slsa.dev/spec/v1.0/levels), which grades build
integrity rather than pass/fail it: Build L1 requires provenance to exist, L2 that a hosted platform
generate and sign it, L3 that the platform "prevent runs from influencing one another, even within
the same project". Three properties are borrowed. Levels are ordered and cumulative, so a system can
report progress without claiming completion. Each level names the specific threat it closes rather
than a virtue it embodies — SLSA's L1 addresses mistakes, L2 tampering after the build, L3 tampering
during it; here L1 addresses uncountable attempts, L2 unattributable resource and reproducibility
claims, L3 confounded comparisons. And responsibility is split between parties, as SLSA splits it
between producer and build platform: here, between the system, its adapter, and the harness. The
split is what makes "an adapter can satisfy this on the system's behalf" a precise statement instead
of a hope.

Two refinements come from elsewhere. The
[OCI distribution specification](https://github.com/opencontainers/distribution-spec/blob/main/conformance/README.md)
splits conformance into categories a registry claims independently — pull, push, content discovery,
content management — and backs each with a runnable conformance tool that a provider submits results
from. That is the source of the optional-capability table, which keeps orthogonal features out of
the level ladder, and of the insistence that each requirement carry a verification status: OCI's
categories mean something because a program decides them. The
[OpenTelemetry semantic conventions](https://opentelemetry.io/docs/specs/semconv/general/semantic-convention-groups/)
grade maturity as development, alpha, beta, release candidate and stable, with the rule that a group
must not reference an element of lower maturity except at the `opt_in` requirement level. The
dependency rule above is that rule, restated for study designs: a design must not depend on a
requirement above the level its systems attain.

The reason to spend this much on verification status is empirical.
[BetterBench](https://arxiv.org/abs/2411.12990) assessed widely used AI benchmarks against a
lifecycle framework of best practices and found that most report neither statistical significance
nor a documented path to replication. Benchmarks do not usually fail by measuring the wrong thing;
they fail by asserting
controls that nothing checks. That is also why the adapter's obligations are written next to the
system's rather than left to each integration: the harness around a model is part of what a result
measures, and an obligation that is not assigned is not met.

## Sources

- [SLSA security levels](https://slsa.dev/spec/v1.0/levels) and
  [SLSA build requirements](https://slsa.dev/spec/v1.2/build-requirements) — cumulative levels,
  threat-to-level mapping, split of responsibility between parties.
- [OCI distribution specification conformance](https://github.com/opencontainers/distribution-spec/blob/main/conformance/README.md)
  — independently claimed categories verified by a runnable tool.
- [OpenTelemetry semantic convention groups](https://opentelemetry.io/docs/specs/semconv/general/semantic-convention-groups/)
  — maturity levels and the rule against depending on a lower-maturity element.
- [OpenTelemetry GenAI semantic conventions](https://github.com/open-telemetry/semantic-conventions-genai)
  and the [GenAI attribute registry](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
  — the model-call vocabulary of R9 and the opt-in treatment of message content.
- [Defeating Nondeterminism in LLM Inference](https://thinkingmachines.ai/blog/defeating-nondeterminism-in-llm-inference/),
  Thinking Machines Lab — batch-size dependence of reduction kernels as the cause of residual
  non-determinism at temperature zero, and batch-invariant kernels as the remedy and its cost.
- [BetterBench: Assessing AI Benchmarks, Uncovering Issues, and Establishing Best Practices](https://arxiv.org/abs/2411.12990),
  NeurIPS 2024 — benchmark lifecycle criteria and the prevalence of unreported significance and
  irreproducibility.
