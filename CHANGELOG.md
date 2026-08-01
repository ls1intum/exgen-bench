# Changelog

This file records changes to the contracts other projects depend on: the generation protocol, the
evaluation protocol, the dataset format, the release format, and the published JSON Schemas in
[`schemas/protocol/`](schemas/protocol/). Internal refactoring is not listed here; read the commit
history for that.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). exgen-bench itself is
pre-alpha and has no released version yet, so every entry below is unreleased. Protocol versions are
independent of any future project version.

## Unreleased

### Benchmark configuration schema 2 (was 1)

Schema 1 configurations are rejected. Update `schema_version` to `"2"`, add
`systems[].attestation.deployment_deviations`, and declare `target.parameters.language` before
running them.

- **Changed** `budget.max_cost.amount` to allow zero. An explicitly unbilled deployment can now
  declare a real zero-cost bound instead of either inventing a positive amount or making strict
  budget compliance unverifiable.

- **Changed** generation identity to include `systems[].factors`, `systems[].parameters`, and
  `target.parameters`. Adapter parameters are opaque to the harness and can select a deployment,
  model, or generation limit, so changing them must mint new attempt identities. Factors remain the
  explicit treatment description used for contrasts.
- **Added** `control` to every factor. A factor is written either as a bare scalar, still accepted
  and read as `{value, control: "declared"}`, or as `{value, control}` where `control` is
  `requested` (the harness sends it, the system applies it, the response echoes it), `observed`
  (the system fixes it, the adapter reports what it saw, the declared value must match), or
  `declared` (an unverifiable label, released as unverified). A `requested` or `observed` factor
  the response contradicts, or does not report, fails the attempt as an infrastructure failure.
- **Added** two rules a multi-arm configuration must satisfy: at least one non-`declared` factor
  must distinguish the arms, and a name cannot be both a fixed `target.parameters` key and an
  arm-varying factor.
- **Added** a factor-name rule. A factor name is a bare lowercase snake_case token of at most 64
  characters — `effort_profile`, not `artemis.effort_profile` and not `effortProfile`. The same
  name is written by a configuration, sent on a request, declared in a capability and echoed by a
  response, and a namespace separator would let those four spellings drift apart. It applies to
  `systems[].factors`, request `factors`, `execution.observed_factors` and the new
  `capabilities.controls` / `capabilities.observes`.
- **Changed** `target.parameters` from an unread free-form object to a typed one requiring
  `language`, accepting `build_system` and any target-specific key, and accepting a
  `case_overrides` map so a dataset can vary the artifact per case. The plan folds the per-case
  value before writing the request, so an override re-mints only the affected case's attempts.
- **Added** `budget.enforcement`, a partial map from budget dimension to `harness` or `system`.
  Declaring `harness` for a dimension the adapter does not list in
  `capabilities.budget_dimensions` refuses the run before any attempt starts.
- **Added** a required `systems[].attestation.deployment_deviations`. It may be an empty list, but
  it cannot be omitted, and a release refuses to export a system without one. A deployment that
  raised a token budget or enabled sandbox slots is a deviation and now has to be recorded in the
  evidence rather than in a pull-request description.
- **Added** `analysis.design`, required whenever the estimand is comparative. It declares the
  smallest meaningful effect and the assumptions behind the power calculation. Planning computes
  the minimum detectable effect, records it with its assumptions and coverage limitation on the
  plan, and refuses a comparative study that cannot detect its own declared effect.

### Attempt observation and release

- **Added** optional OpenRouter reference pricing. A run snapshots the public model and endpoint
  responses, retains their HTTP and local retrieval times and SHA-256 digests, calculates with exact
  decimal rates, and publishes the estimate, rate basis, assumptions, active-route range, and quote
  digest. Reference cost remains separate from provider-reported `cost` and cannot satisfy a budget.
- **Added** cached-input and reasoning-token columns to analysis-ready attempt records. These token
  classes were already part of generation protocol 2 but were not carried into public tabular data.

- **Changed** `budget.status`. `compliant` now requires evidence: a dimension with no declared
  limit, or no reported usage, is `unverifiable`, and a dimension whose system-reported ceiling is
  at or below the declared limit is `non_binding` rather than compliant, because nobody could have
  violated it. The attempt-level status is the worst dimension. A `non_binding` dimension still
  satisfies the budget leg of strict success; an `unverifiable` one does not.
- **Added** `budget_dimensions` and `system_configuration` to the attempt observation: the
  per-dimension verdict with its declared limit, observed value, system-reported ceiling, the
  ceiling's `system_limit_source`, and declared enforcement, plus the system-reported parameters,
  limits and factors for that attempt.
- **Added** `factor_controls` and `attestation` to published system metadata, so a reader can tell
  a verified factor from an unverified label, and `analysis.inference_limitations` to the release
  manifest, recording that the percentile case-clustered bootstrap has no asymptotic refinement and
  under-covers below roughly forty clusters, with the literature it is measured against.

### Generation protocol 2 (was 1)

Adapters must be updated. The runner rejects a response declaring `protocol_version: "1"`.

- **Added** `recover` as a third subcommand alongside `describe` and `generate`. An adapter that
  advertises crash recovery uses it to stop durable remote work before the runner classifies an
  uncertain attempt as interrupted. An adapter that does not advertise recovery does not need it.
- **Added** `diagnostics`: bounded, content-digested files such as event journals and stage
  checkpoints. Diagnostics are operational evidence, never candidate content. Each declares a
  `visibility`, and event journals must be UTF-8 newline-delimited JSON with a verified record count.
- **Added** `capture.completeness` so an adapter can report that it captured some but not all of a
  terminal workspace, instead of choosing between a complete claim and nothing.
- **Changed** usage reporting to distinguish an unobserved quantity from zero. A field that the
  adapter could not measure is absent; it is never reported as `0`.
- **Added** `factors` to the generation request, carrying every factor the configuration declared
  as `requested`. An adapter must apply them and echo them back.
- **Added** `execution.observed_factors` and `execution.effective_limits` to the generation
  response. `observed_factors` is what the system reports it actually ran with, and is checked
  against every `requested` and `observed` factor. `effective_limits` is the system's own ceiling
  per budget dimension, and is what makes a declared limit `non_binding` instead of `compliant`.
  Successful responses establish a baseline for the same system, adapter parameters, requested
  factors, and resolved target. A later successful response in that scope whose effective model,
  parameters, or limits change fails as configuration drift. Failed, abstained and infrastructure
  responses may carry partial execution data, so they remain subject to factor and seed attestation
  but neither establish nor contradict that complete baseline.
- **Added** `capabilities.budget_dimensions`, the budget dimensions the adapter actually enforces.
  Absent means the adapter predates the field and enforces nothing.
- **Added** `capabilities.controls` and `capabilities.observes`, the factor names an adapter can
  apply to a run and can attest afterwards. Preflight refuses a configuration whose `requested`
  factor is absent from `controls`, or whose `observed` factor is absent from `observes`, so a
  study naming a factor the system cannot apply or cannot attest is rejected before any network
  round trip. Both are optional; absent means the adapter declares nothing and therefore supports
  no non-`declared` factor, matching how `budget_dimensions` is read. The two lists differ in
  practice: a system may accept a control it never echoes back, and a factor that is applied but
  not attested rests on the adapter's word alone, which is not enough to ground a contrast.
- **Changed** `execution.effective_limits` so each limit may carry its source. A limit is written
  either as a bare number, still accepted and read as unsourced, or as `{value, source}` where
  `source` is `system_reported` or `system_configured`; `cost` takes the same `source` alongside
  `amount` and `currency`. Only `system_reported` can support a `non_binding` verdict, because that
  verdict claims the system's own guard bound before the declared limit did, and only the system
  can support that claim. An unsourced or `system_configured` value is still recorded, with its
  source, on the attempt's `budget_dimensions`, but leaves the dimension `compliant` or
  `unverifiable` on its own merits. An adapter that reports bare numbers keeps parsing and only
  loses `non_binding`, which is the safe direction for a schema change.
- **Changed** the capability handshake to run with the system's declared environment, so an adapter
  that derives its identity from its environment can identify itself. Without this a second arm of
  the same adapter binary could never pass preflight.
- **Changed** `parameters_schema` from published-and-ignored to enforced. The runner validates
  `systems[].parameters` against it after `describe`, so a mistyped parameter is a preflight error
  rather than a crash inside the first attempt.
- **Added** a cross-check between `capabilities.seed` and `execution.seed_status`. An adapter that
  declares `unsupported` and reports `honored`, or declares `deterministic` and reports anything
  else, fails the attempt.

### Evaluation protocol

- **Added** the process-evaluator configuration
  ([`schemas/protocol/process-evaluator-config.schema.json`](schemas/protocol/process-evaluator-config.schema.json)),
  which binds an evaluator's identity, suite, execution limits, and environment references to every
  request and records its digest in the evaluation identity. See
  [the guide](docs/PROCESS-EVALUATORS.md).
- **Removed** the Artemis-specific evaluator API. Target verification belongs to the system under
  test; independent evaluation goes through the process-evaluator protocol.

### Dataset schema 2 (was 1)

Schema 1 datasets are rejected. Update `schema_version` to `"2"` and add the provenance fields
required below where applicable.

- **Added** conditional provenance requirements: a case whose `origin.kind` is `adapted` or
  `collected` must carry `source_uri` and `citation`, and a case declared publicly exposed must carry
  `first_public_at`.

### Published schemas

- **Fixed** a divergence between the Zod contracts and the published schemas. Schemas were generated
  with the output projection, so every field carrying a default was marked required — a document
  exgen accepted could be rejected by a third-party validator reading our own schema. Schemas are
  now classified by who authors the documents they validate. Documents written outside exgen
  (dataset, benchmark config, generator descriptor, generation response, evaluation response,
  process-evaluator config, metric cards) no longer require a defaulted field.
- **Fixed** two rules that differed rather than being merely weaker: URL fields now apply the same
  rule in both the contract and the schema, and RFC 3339 timestamps require seconds in both.

### Removed

- The proposed Artemis benchmark API (`benchmark-api.openapi.yaml`) and its client. Artemis is now
  driven through the same production endpoints the instructor interface uses; see
  [the integration design](docs/ARTEMIS-INTEGRATION.md).
