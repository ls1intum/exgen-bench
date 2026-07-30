# Public protocol schemas

The approach-agnostic JSON Schemas under [`protocol/`](protocol/) are generated from the runtime
contracts in `src/`, `site/`, and the adapters.

```bash
bun run schemas
```

Do not edit generated schemas by hand. Breaking interoperability changes require a protocol-version
change, a migration-impact description in the pull request, regenerated schemas, and adapter
contract tests. CI regenerates the schemas and rejects uncommitted drift.

The generated schemas include the structural and conditional rules encoded by the runtime
contracts. Runtime validation additionally enforces references and compound uniqueness derived
from other values, plus accounting equalities and comparisons between sibling values. These
include configured system references, metric and release identities, catalog references,
aggregate reconciliation, rate calculations, and interval ordering. They cannot be represented
portably in Draft 2020-12, so schema acceptance alone is not a conformance result.

[`tests/schema-conformance.test.ts`](../tests/schema-conformance.test.ts) checks the generated
schemas with an independent validator against the conditional rules also enforced at runtime.
