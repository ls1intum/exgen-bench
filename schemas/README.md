# Public protocol schemas

The approach-agnostic JSON Schemas under [`protocol/`](protocol/) are generated from the runtime
contracts in `src/`, `site/`, and the adapters.

```bash
bun run schemas
```

Do not edit generated schemas by hand. Breaking interoperability changes require a protocol
version, migration note, regenerated schemas, and adapter contract tests. CI regenerates the
schemas and rejects uncommitted drift.

JSON Schema covers the portable wire structure. Cross-record identity, uniqueness, and accounting
rules are enforced by the CLI and contract tests; schema acceptance alone is not a conformance
result.
