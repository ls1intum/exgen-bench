# Documentation

Start with the [project README](../README.md) to run the smoke test and small example.

## Understand the benchmark

- [Glossary](GLOSSARY.md) defines the terms used across the project.
- [System design](../SYSTEM-DESIGN.md) explains the components, stored records, resume behavior,
  and release process.
- [Methodology](METHODOLOGY.md) defines what is measured and how formal comparisons are designed
  and reported.

## Integrate and contribute

- [Artemis integration](ARTEMIS-INTEGRATION.md) describes the proposed Artemis and Hyperion
  boundary.
- [Protocol schemas](../schemas/README.md) documents the generated JSON Schemas used by adapters.
- [Results-site guide](../site/README.md) explains the public release input and local preview.
- [Contributing](../CONTRIBUTING.md) lists the development checks and project constraints.
- [Security policy](../SECURITY.md) defines where generated code may run.

## Maintain project images

| Asset | Purpose | Source |
| --- | --- | --- |
| `site/social-preview.png` | Repository and website link previews | `site/social-preview.html` |
| `docs/images/system-overview.png` | System-design overview | `docs/figures/system-overview.html` |
| `docs/images/success-definition.png` | Primary-outcome explanation | `docs/figures/success-definition.html` |
| `browser-tests/visuals/results-site-overview.png` | Results-site visual baseline | `site/src/` and illustrative data |

The figures, social card, and results site share the palette and typeface in `site/brand.css`. CI
compares the rendered images pixel for pixel in a pinned Linux/amd64 Chromium environment.
Regenerate them from the repository root:

```bash
docker run --rm --platform linux/amd64 --ipc=host --user 1001 \
  --env EXGEN_VISUAL_TESTS=1 --volume "$PWD:/work" \
  --tmpfs /work/node_modules:rw,exec,uid=1001,gid=1001,mode=0755 --workdir /work \
  mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e \
  sh -lc 'xargs -I{} npx --yes bun@{} install --frozen-lockfile < .bun-version && \
  xargs -I{} npx --yes bun@{} run browser:test -- --project=visual-chromium \
  --update-snapshots < .bun-version'
```
