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

For changes to the results site, also run:

```bash
bunx playwright install --with-deps chromium firefox webkit
bun run browser:test
```

## Public images

| Asset | Purpose | Source |
| --- | --- | --- |
| `site/social-preview.png` | Repository and website link previews | `site/social-preview.html` |
| `docs/images/system-overview.png` | System-design overview | `docs/figures/system-overview.html` |
| `docs/images/success-definition.png` | Primary-outcome explanation | `docs/figures/success-definition.html` |
| `browser-tests/visuals/results-site-overview.png` | Results-site visual baseline | `site/src/` and illustrative data |

The figures, social card, and results site share the palette and typeface in `site/brand.css`. CI
compares these rendered images pixel for pixel in a pinned Linux/amd64 Chromium environment.
Regenerate the images from the repository root:

```sh
docker run --rm --platform linux/amd64 --ipc=host --user 1001 \
  --env EXGEN_VISUAL_TESTS=1 --volume "$PWD:/work" \
  --tmpfs /work/node_modules:rw,exec,uid=1001,gid=1001,mode=0755 --workdir /work \
  mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e \
  sh -lc 'xargs -I{} npx --yes bun@{} install --frozen-lockfile < .bun-version && \
  xargs -I{} npx --yes bun@{} run browser:test -- --project=visual-chromium \
  --update-snapshots < .bun-version'
```

## Project constraints

- Keep generator, target, evaluator, execution, storage, and reporting concerns separate.
- Keep public adapter boundaries language-neutral and versioned with JSON Schema.
- Do not count cached files or repeated scans as new observations.
- Do not silently retry stochastic generation.
- Preserve every outcome and distinguish a rejected exercise from a tool or service failure.
- Pass process arguments as arrays; do not shell-split configuration.
- Add rejection and path-containment tests when handling files or archives.

Breaking contract changes require a protocol-version change and must describe migration impact in
the pull request. Keep pull requests focused, and explain changes to identities, retry behavior,
denominators, or public disclosure in the pull-request description. See
[System design](SYSTEM-DESIGN.md), [methodology](docs/METHODOLOGY.md), and
[glossary](docs/GLOSSARY.md) for the reasons behind these constraints and the terms used here.
