# Changelog

This file records changes to the contracts other projects depend on: the generation protocol, the
evaluation protocol, the dataset format, the release format, and the published JSON Schemas in
[`schemas/protocol/`](schemas/protocol/). Internal refactoring is not listed here; read the commit
history for that.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). exgen-bench itself is
pre-alpha and has no released version yet, so every entry below is unreleased. Protocol versions are
independent of any future project version.

## Unreleased

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

### Evaluation protocol

- **Added** the process-evaluator configuration
  ([`schemas/protocol/process-evaluator-config.schema.json`](schemas/protocol/process-evaluator-config.schema.json)),
  which binds an evaluator's identity, suite, execution limits, and environment references to every
  request and records its digest in the evaluation identity. See
  [the guide](docs/PROCESS-EVALUATORS.md).
- **Removed** the Artemis-specific evaluator API. Target verification belongs to the system under
  test; independent evaluation goes through the process-evaluator protocol.

### Dataset format

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
