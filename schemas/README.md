# Public protocol schemas

The JSON Schemas under [`protocol/`](protocol/) define the files exchanged with adapters and the
files published in a release. They are generated from the validation rules in `src/`, `site/`, and
the adapters.

`process-evaluator-config.schema.json` is the operational contract for a generic external
evaluator. Its environment map contains host variable names only; secret values are resolved at
runtime and are never part of the document.

## Defaulted fields

A schema for a document authored outside exgen and validated by it — the dataset, benchmark config,
generator descriptor, generation response, evaluator identity, evaluation suite, evaluation
response, process-evaluator config, and metric cards — publishes a field the loader defaults as
optional, with the default recorded, because a producer that omits it is genuinely accepted. A
schema for a document exgen emits — the generation request, evaluation request, public attempt,
public catalog, and public release — publishes that field as required, because exgen applies the
default before writing and a consumer can rely on it. Every schema declares its direction in
[`scripts/export-schemas.ts`](../scripts/export-schemas.ts).

## Generation protocol v2

Generator adapters advertise `"protocol_version": "2"` from `describe --json`, accept requests
carrying it, and write responses carrying it. `generation-response.schema.json` enforces the rest,
including the part an adapter author is most likely to miss: a response whose `status` is
`succeeded` must declare at least one artifact, so `artifacts` may only be omitted by a response
that did not succeed.

A response may declare up to 128 diagnostic files. Every declaration carries an ID, kind, safe
relative path, media type, exact SHA-256, byte count, optional record count, and visibility. Event
journals are UTF-8 newline-delimited JSON and require a verified record count. Diagnostic files are
bounded, may not overlap candidate artifacts, and reject traversal, absolute paths, symlinks, and
hard links. Diagnostics are private operational evidence by default: `visibility` is disclosure
metadata, not an authorization mechanism, the raw attempt store stays access-controlled, and the
release exporter does not copy diagnostic payloads.

`kind: checkpoint` declares an immutable generator snapshot. Exgen authenticates and retains the
file but does not interpret or resume it, and protocol v2 deliberately adds no mid-attempt
stochastic resume. Reusing a checkpoint is a separately configured causal fork with its own attempt
identity, so a checkpoint can explain a failure without mixing operational state into candidate
identity or changing the planned-attempt denominator.

```bash
bun run schemas
```

Do not edit generated schemas by hand. Breaking interoperability changes require a protocol-version
change, a migration-impact description in the pull request, regenerated schemas, and adapter
contract tests. CI regenerates the schemas and rejects uncommitted drift.

The generated schemas include structural rules and conditions between fields. Runtime validation
also checks references, uniqueness across several fields, totals, calculated rates, and interval
ordering. These checks cannot all be represented portably in JSON Schema Draft 2020-12, so passing
schema validation alone does not prove full compatibility.

[`tests/schema-conformance.test.ts`](../tests/schema-conformance.test.ts) checks the generated
schemas with a second validator. The [glossary](../docs/GLOSSARY.md) defines the terms used by the
published records.

## What an adapter declares about factors

`capabilities.controls` and `capabilities.observes` are two independent optional lists of factor
names: the factors the adapter can apply to a run, and the factors it can attest afterwards. They
are separate because the asymmetry is real — a system may accept a setting it never echoes back, and
a setting that is applied but not attested rests on the adapter's word, which cannot ground a
contrast. Absent means the adapter declares nothing and therefore supports no non-`declared` factor,
the same way `budget_dimensions` is read. Preflight refuses a study naming a factor outside the
relevant list, before any network round trip.

A factor name is a bare lowercase snake_case token of at most 64 characters, and the same spelling
must appear in `systems[].factors`, the request `factors`, `execution.observed_factors`, and these
two lists. A namespace separator would let four spellings of one name drift apart.

## Two lessons from a live campaign

A two-arm live campaign lost six paid-for generations to adapter defects. Two generalize:

- **Be strict about what you read, loose about what you pass through.** A `strictObject` on a field
  the adapter only forwards rejected a purely additive server change and destroyed the run, while
  the field rename it was meant to catch happened on the loose parent and passed silently. Validate
  every field you depend on and let the rest through; a schema that fails on a server *addition* is
  a liability, and one that ignores a *rename* of something you read is a different bug.
- **A result that cannot be non-zero is not a result.** A cleanup command that could never delete
  anything reported success with `deleted: 0`, which is indistinguishable from a clean run. Any
  count an adapter reports should be reachable from a code path that can produce another value.

Implementing the protocol is necessary but not sufficient. What the system behind an adapter must
support — and which study designs each level of support unlocks — is in
[`docs/SUT-REQUIREMENTS.md`](../docs/SUT-REQUIREMENTS.md).
