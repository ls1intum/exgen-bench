# Contributing

Use [GitHub Issues](https://github.com/ls1intum/exgen-bench/issues) for reproducible bugs. Open a
methodology or design proposal before changing a public contract, study assumption, or scientific
interpretation. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
Participation is governed by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setup

Install the [Bun](https://bun.sh/docs/installation) version listed in
[`.bun-version`](.bun-version), then:

```bash
bun install --frozen-lockfile
```

Run the smallest relevant test while developing. Before submitting a change:

```bash
bun run check
```

For protocol changes, regenerate and commit the public schemas:

```bash
bun run schemas
```

Commit the resulting schema changes with their contract source.

For changes to the results dashboard, also run:

```bash
bunx playwright install --with-deps chromium firefox webkit
bun run browser:test
```

## Project invariants

- Keep generator, target, evaluator, execution, storage, and reporting concerns separate.
- Keep public adapter boundaries language-neutral and versioned with JSON Schema.
- Do not turn cached artifacts or repeated file scans into independent observations.
- Do not silently retry stochastic generation.
- Preserve every outcome and distinguish scientific failure from infrastructure failure.
- Pass process arguments as arrays; do not shell-split configuration.
- Add rejection and path-containment tests when handling files or archives.

Breaking contract changes require a protocol-version change and must describe migration impact in
the pull request. Keep pull requests focused, and explain changes to identities, retry behavior,
denominators, or public disclosure in the pull-request description. See
[System design](SYSTEM-DESIGN.md) and [Methodology](docs/METHODOLOGY.md) for the reasons behind these
constraints.
