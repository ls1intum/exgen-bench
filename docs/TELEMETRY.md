# Telemetry and accounting profile

Telemetry is process evidence, not the quality verdict and not a universal source of truth. Exgen
uses [OpenTelemetry](https://opentelemetry.io/docs/specs/otel/) and OTLP as the vendor-neutral
transport and adopts the
[OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
for model-call metadata. Those GenAI conventions are still marked **Development**, so formal runs
pin the instrumentation and Collector versions and retain a versioned normalized trace rather than
assuming that future attribute names are compatible.

## Profile reference

### What a capture requires

The `exgen.otel.genai.v3` profile is the single version identifier for this evidence; there is no
second schema counter. It requires one correlated attempt trace, 100% sampling, bounded capture, no
orphan spans, no reported dropped attributes/events/links, and complete
`gen_ai.usage.input_tokens` and `gen_ai.usage.output_tokens` on every counted model span. A model
span is one whose `gen_ai.operation.name` is `chat`, `text_completion`, or `generate_content`, so an
inference span that reports no usage is a rejection rather than an omission. A byte-identical span
re-sent by an OTLP exporter retry is collapsed and counted in `completeness.duplicate_span_ids`; two
different records for one span ID are rejected. When a product exposes independent accounting or
provider request IDs, exgen reconciles them exactly and fails closed on disagreement.

### Normalization at the decode boundary

Two producer dialects are normalized at the decode boundary, so that for those two the encoding a
producer chose cannot reach a downstream rule or change the evidence bytes. This is not an edge
case. A Micrometer `KeyValue` is string-typed by construction, so a Spring Boot system under test
emits every attribute — including every token counter — as an OTLP `stringValue`; there is no other
AnyValue kind available to that bridge and no configuration that changes it.

- Integer-typed GenAI attributes are accepted as a JSON number or a decimal string and stored as a
  number. Anything that is not a plain non-negative decimal integer — a non-numeric string, a
  negative, a float, or a leading-zero form — is rejected with the attribute and the value named.
- `finish_reason` is case-folded and aliased to the convention value, and the canonical value is what
  the evidence stores. Spring AI forwards the backing provider SDK's stop reason verbatim, so the
  dialect follows the provider rather than the system under test: OpenAI `TOOL_CALLS`, Anthropic
  `end_turn` / `max_tokens` / `tool_use`, Gemini `SAFETY` / `MAX_TOKENS` / `MALFORMED_FUNCTION_CALL`.
  A value is aliased when it maps onto exactly one convention value; anything else is stored exactly
  as received and listed in `unmapped_finish_reasons`.

Aliasing can narrow a provider distinction the convention does not carry: `refusal` (the model
declined) and `recitation` (a copyright block) both become `content_filter`. That is a deliberate
loss in the canonical field, bounded because nothing reconciles on a finish reason and the raw value
stays recoverable through the attested source segment.

Not every 64-bit encoding is normalizable, and where it is not, the profile rejects rather than
guesses. A JSON number carries an integer exactly only to 2^53-1, while a nanosecond timestamp is
about 1.79e18: the value is already rounded by the time a JSON parser hands it over. Such a value is
rejected with the limit named and the producer directed to the decimal string form, which OTLP/JSON
permits and which is lossless. In an evidence plane a loud rejection is a better failure than a
silently corrected record.

An unmapped finish reason, by contrast, is recorded and never fatal. The convention itself types the
field as `anyOf [FinishReason, string]`
([semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai), model/gen-ai/gen-ai-output-messages.json),
a finish reason is descriptive metadata, and no reconciliation depends on it — so rejecting an
unrecognized value would discard a whole correlated trace over a field the specification permits.
A structurally missing or empty `finish_reason` is still a rejection.

Only the finish reason is rewritten inside a content attribute, and only when it differs from the
canonical value; everything else is stored exactly as received. The attested source-segment digest
covers the raw bytes either way, so the wire form remains recoverable.

### Optional token classes and reconciliation

The profile records coverage counts for cache-read, cache-creation, reasoning-output token, and
fresh output-message attributes. It publishes an aggregate for an optional class only when every counted model span
reported that class, validates each breakdown against its inclusive input/output total, and
reconciles the aggregate when an independent source supplies one. Absence is unknown, never zero.
That rule cuts both ways, and the reconciliation respects it: when a product supplies an expected
value for an optional class that the trace cannot observe — because the attribute is not reported on
every counted model span — the field is classified `not_observable` in
`usage_reconciliation_fields` and the reconciliation is reported as `partially_observable`. It is
not a disagreement, because the trace never made a competing claim; an expected
`cache_read_input_tokens` of `0` against a producer that reports no cache detail is missing
information, not a contradiction, and must not fail an otherwise healthy attempt. A field the trace
can observe is still compared exactly and still fails closed, and the error names the fields that
disagreed.
When output messages are complete, `toolCalls` is the count of model-requested `tool_call` parts,
including requests that a SUT later rejects or declines to execute. It is not a success counter.
The evidence also inventories fresh output text, tool-call, and provider-exposed reasoning parts and
reasoning characters. Input-message replay is deliberately excluded from these counts.

### Correlation

Correlation is adapter-supplied today. An adapter names one span attribute and one value, and exgen
selects the trace that carries it; every other span of that trace is retained by trace ID. Artemis
uses `artemis.hyperion.job.id`, which its Hyperion job root span carries, because an asynchronous
generation job loses request context at the queue boundary.

An attempt identifier must be a span attribute, not a resource attribute: resource attributes
identify a process and cannot safely vary across concurrent attempts in a long-lived service.

### Content tiers

A capture selects one of three content policies.

| `content_capture` | Every counted model span must | A declared truncation is |
| --- | --- | --- |
| `required` | carry both standard message attributes | recorded; presence is what is demanded |
| `bounded` | carry both, **or** declare that the system bounded that span's content | the reason the span is accepted |
| `forbidden` | carry no content attribute at all, on any span | not applicable |

The formal Artemis adapter deliberately selects the restricted opt-in tier because causal audit of
its multi-call agent loop is an explicit study requirement. Its validated deployment environment
enables standard input/output message attributes, and the adapter verifies that both attributes are
present and valid on every counted model span. A configuration declaration alone is insufficient.

### Bounded content

Every system under test bounds attribute sizes somewhere, and a system that bounds content and says
so is more trustworthy than one that does not — so the profile must be able to represent it without
either discarding the trace or pretending the content is whole. `bounded` demands content on every
counted model span exactly as `required` does, and accepts a span that lacks it only when the system
explicitly declared that it bounded that span. **A span with neither content nor a declaration is
still a rejection under `bounded`**; that distinction — declared truncation against silent absence
— is the entire content of the state, and it is what stops `bounded` from degenerating into
"content is optional". A capture configured as `bounded` without a declaration attribute is refused
outright rather than silently behaving as `required`.

There is no convention attribute for this. The GenAI conventions anticipate the loss — instrumentations
"MAY provide a way for users to filter or truncate input messages", and MAY offer "a configuration
option allowing to truncate properties such as individual message contents"
([semantic-conventions-genai](https://github.com/open-telemetry/semantic-conventions-genai), docs/gen-ai/gen-ai-spans.md) —
but define nothing that records whether it happened. The OpenTelemetry SDK limit is explicitly silent
in the other direction: over `AttributeValueLengthLimit` an SDK "MUST truncate that value"
([specification/common/README.md](https://github.com/open-telemetry/opentelemetry-specification/blob/main/specification/common/README.md), Attribute Limits),
with no signal at all; `droppedAttributesCount` counts attributes the SDK discarded whole and stays
fatal here. **The declaration seam is therefore ours, not the convention's.** The generic profile
names no attribute: an adapter supplies the one its system uses, and the evidence records that name
in `content_truncation.declared_by` so a reader knows what the claim rests on. Artemis maps
`artemis.gen_ai.content.complete`. The value crosses the Micrometer bridge as a string, so `false`
and `"false"` are both accepted and anything else is rejected by name.

Truncation is a property of the evidence, never of the generation: it is recorded under every
policy, including `required`, and on its own it changes no outcome. What it changes is what a reader
can conclude. `content_truncation` carries the shape of the loss — how many spans were bounded,
which ones, how many content bytes survived on them, and how many content bytes the trace holds in
total — because a trace with 15 of 75 spans bounded supports a different claim than one with 1 of 75.
How much a system discarded is not recoverable from the trace; the profile records what survived and
does not estimate the rest. A study that needs whole content keeps using `required`, and one that
needs it under `bounded` reads `truncated_span_count === 0`.

The metadata-only tier uses an allowlist, not a content-attribute denylist. It retains correlation,
span identity and timing, standard model/provider/request metadata, and token counts. It
drops resource and instrumentation-scope attributes, arbitrary span attributes, span names and
status, event payloads, and link attributes. This matters because GenAI conventions and vendor
instrumentation can add sensitive fields without changing exgen. Known content attributes still
cause a rejection rather than silent redaction, so a deployment that was meant to disable content
capture cannot be mistaken for a conforming metadata-only deployment.

### What each evidence record contains

Every restricted trace record includes correlation, the trace ID and the correlated span IDs;
resource and instrumentation-scope identities with their schema URLs; span flags and trace state;
scalar, array, and key/value attributes normalized identically on spans, events, and links; events,
links, status, and dropped-item counts; a stable-poll completion attestation; model response IDs and
token use; exact reconciliation status; and whether sensitive content attributes were present.
It also includes a fresh-output content inventory, so reasoning and tool-call analysis does not
depend on ad hoc transcript parsing. This inventory does not equate visible reasoning characters
with provider reasoning tokens. Schema URLs are retained because the GenAI conventions are still
Development: knowing which semantic-convention version produced an attribute is what makes an
attribute rename recoverable rather than a silent loss.

A metadata-only record is intentionally not a redacted restricted record. It contains only the
allowlisted fields described above. The restricted archive preserves the complete normalized trace
because its opt-in content policy, access controls, and retention policy apply to the whole record.

## Operating a capture

### Collector deployment and containment

The Collector remains outside the system under test. The local reference deployment uses the
Collector's JSON file exporter because it is simple, offline, and reproducible, but that exporter is
[alpha and does not promise stable field names](https://github.com/open-telemetry/opentelemetry-collector-contrib/tree/main/exporter/fileexporter).
This is contained rather than ignored: the image is digest-pinned, the parser has adversarial
failure-path tests over synthetic OTLP/JSON, the exact source byte range is hashed over the raw
bytes of complete records only, and normalized evidence declares `exgen.otel.genai.v3`. Evidence
names its capture `source`, so a trace-backend query records a different source under the same
profile. A cross-system conformance pack covering multiple producer stacks remains necessary.

The Collector file is always restricted input. Metadata-only projection happens in exgen after
collection, so the source file can still contain prompts, outputs, credentials, or vendor-specific
attributes and requires the same access controls and retention policy as other restricted evidence.

Restricted is the default, not a prohibition. A retained trace may be published deliberately, and
[`corpora/`](../corpora/README.md) does exactly that for one system so evaluators can be developed
against real output. That is a decision about a specific system whose prompts are open, taken once
and recorded in the corpus. It does not weaken the default: a trace is restricted until somebody
decides otherwise, publication is irreversible, and a trace must be scanned for credentials first.

### Quiescence and export cadence

A capture is complete when the observed span set stops changing for `stable_poll_count` polls, and,
when the product supplies independent accounting, when observed usage first matches it. That
positive predicate matters because the stability window alone is shorter than the export cycle:
`stable_poll_count` 2 at a 250 ms poll interval is 500 ms, while Spring Boot's OTLP exporter batches
on a schedule and the Collector's batch processor adds its own timeout. Formal Artemis runs
therefore set `MANAGEMENT_OPENTELEMETRY_TRACING_EXPORT_SCHEDULE_DELAY=1s` alongside the other
tracing variables, and the Collector uses a 1 s batch timeout, keeping the total export latency well
inside the capture timeout. A capture that never reconciles fails closed with the disagreement, not
with a bare timeout.

### Bounded reading and rotation

`max_bytes_per_attempt` bounds the bytes retained for the correlated trace, not the size of the file
suffix: an attempt must not become more likely to fail because unrelated background traffic shares
the Collector. The file is read forward with an advancing cursor, its device and inode are pinned
for the attempt so a rotation that reuses the path is rejected, and a partially written trailing
record is excluded from both the parsed spans and the attested byte range.

### Preflight and queue loss

Collector/SDK queue loss that occurs before span creation cannot be proven absent from the trace
alone. Formal preflight therefore exercises the real SUT-to-Collector path, formal runs use 100%
sampling, and independent product/provider reconciliation is required whenever the treatment
supports it. Preflight decodes what it observes through the same normalization and validation path a
capture uses, and fails when a model span is present and cannot be decoded, because delivery of
bytes is not evidence that the attributes are readable. Preflight reports which of the two it
established: `model_span_decoded`, or `delivery_only` when spans arrived but none of them was an
inference span. `delivery_only` is a weaker result — it leaves the decoding path unproven until the
first attempt, so a preflight that must prove decoding has to trigger one real model call. A future
cross-system conformance pack should add a known synthetic model/tool canary and Collector
self-telemetry for refused/dropped spans before `submitted` releases are enabled.

## Why it is built this way

### Authority is claim-specific

There is deliberately no single “canonical plane.” Treating either a product cache or
self-reported telemetry as authoritative for every claim would create a correlated measurement
failure.

| Claim | Primary record | Independent check |
| --- | --- | --- |
| Planned attempt, treatment, lifecycle, budget | append-only exgen ledger | frozen plan and attempt evidence manifest |
| Candidate bytes and evaluator result | content-addressed exgen evidence | artifact/evaluator digests and release verification |
| Model/tool execution, timing, errors | correlated OpenTelemetry trace | product accounting and provider records when available |
| Product completion and saved version | normal product API/status | persisted artifact/version identities |
| Billed provider cost | provider billing API/ledger | token and request-ID reconciliation |
| Static price estimate | declared price table | marked as an estimate; never substituted for provider billing |

For Artemis, Hazelcast is only a bounded operational reconnect and cancellation cache. It is not a
benchmark ledger, durable provenance store, or cross-system telemetry standard. Exgen captures the
terminal product attestation while it exists and seals it into attempt evidence. No Artemis database
migration is required.

### Content and privacy

Metadata-only capture is the cross-system default. The normalized record retains only the allowlist
described above even when instrumentation emits richer telemetry. Prompt and completion bodies are
opt-in because they can contain personal data, secrets, hidden evaluator material, or copyrighted
content. OpenTelemetry likewise marks `gen_ai.input.messages` and `gen_ai.output.messages` as opt-in
and warns that they are likely sensitive.

The generator-visible brief and frozen output artifacts are already preserved by exgen. A study
that genuinely needs intermediate model content must preregister that need, use the standard GenAI
message attributes, encrypt the restricted operational archive, define retention/access controls,
and publish only digests or redacted derivatives. Hidden chain-of-thought is never required. A
provider-exposed reasoning summary or explicit reasoning block is observable model output and may
be retained as a standard `reasoning` message part under the same restricted-content controls.
Opaque/encrypted reasoning state is retained only when it is part of the actual request/response
needed for replay; exgen never attempts to decrypt, infer, or score private chain-of-thought.
This follows the provider boundary rather than inventing a proxy: OpenAI documents that raw
[reasoning tokens are not visible](https://developers.openai.com/api/docs/guides/reasoning) while
reasoning summaries and opaque replay state may be returned, and Anthropic exposes explicit
[thinking blocks and signatures](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking).
Reasoning-token usage is recorded only when the provider or instrumentation reports it; tokenizing
visible reasoning text locally would not reconstruct hidden tokens and would create false precision.

### Vocabulary compatibility

[OpenInference](https://arize-ai.github.io/openinference/spec/semantic_conventions.html) is a useful
OpenTelemetry-compatible vocabulary for RAG, evaluator, and agent details that are not yet mature in
the core GenAI conventions. Exgen should accept it through a versioned normalization profile when a
SUT already emits it; requiring both conventions or copying OpenInference attributes into Artemis
would create duplicate, framework-specific instrumentation and is not the default.

### Methodological boundaries

Telemetry measures treatment execution; it does not establish exercise quality. Quality comes from
the frozen candidate and an independent evaluator. Missing telemetry must not be selectively
excluded: it is classified under the preregistered infrastructure/failure policy, and every affected
paired block remains visible. The same sampling, Collector, capture profile, and retention policy
must apply to all compared arms to avoid differential measurement.

The wider policy follows [NIST AI RMF 1.0](https://doi.org/10.6028/NIST.AI.100-1), the
[NIST Generative AI Profile](https://doi.org/10.6028/NIST.AI.600-1), and the construct-validity and
transparent multi-metric principles in [HELM](https://arxiv.org/abs/2211.09110). Dataset and release
provenance use content identities and RO-Crate; these implement the practical lineage goals of
[W3C PROV](https://www.w3.org/TR/prov-overview/) without putting a second tracing ontology into each
system under test.

A release is disqualified, regardless of every other property, by any of: a database migration or
benchmark-only persistence added to a system under test, a telemetry disagreement that is observed
and not surfaced, a sampled formal trace, hidden evaluator leakage, undisclosed raw-content capture,
or an exact-cost claim resting only on a static price table.

## Status

### Not implemented yet

W3C [Trace Context](https://www.w3.org/TR/trace-context/) plus
[Baggage](https://www.w3.org/TR/baggage/) carrying an `exgen.attempt.id` would be the portable
alternative for synchronous command and container adapters, which could then receive an
exgen-managed OTLP endpoint and an injected trace context. No exgen code propagates `traceparent`,
baggage, or `OTEL_EXPORTER_*` today.

### Provider identity

The evidence records no provider field. If one is ever added, note that the reference stack predates
the convention's rename: it sets `gen_ai.system` (`openai`) and does not set `gen_ai.provider.name`.
