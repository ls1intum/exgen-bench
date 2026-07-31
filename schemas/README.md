# Public protocol schemas

The JSON Schemas under [`protocol/`](protocol/) define the files exchanged with adapters and the
files published in a release. They are generated from the validation rules in `src/`, `site/`, and
the adapters.

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
