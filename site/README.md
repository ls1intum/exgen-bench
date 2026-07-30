# Results dashboard

This directory contains the static React client for precomputed public releases. It compares
model-and-approach configurations by strict acceptance, cost, and latency. The browser filters and
presents checksummed estimates; it does not compute them.

## Preview

```bash
bun run site:validate
bun run site:serve
```

Then open <http://localhost:4173>. Opening `index.html` directly is not supported because browsers
block local JSON requests.

## Release input

`data/catalog.json` lists versioned release manifests and selects a `default_release_id`. Each
release supplies:

- complete page metadata and precomputed aggregates in `release.json`;
- one row per planned attempt in JSONL and CSV;
- metric cards; and
- checksums for downloadable artifacts.

Each system is one model-and-approach configuration. Factors named `approach`, `model`, and
`provider` drive labels and filters. Cost and latency summaries are independently optional.
Validation reconciles every published summary to the public attempt rows.

The checked-in release is invented demonstration data, not a benchmark result. Regenerate it with
`bun run demo:generate`. Public release and attempt contracts are in
[`schemas/protocol/`](../schemas/protocol/).

## Build from a verified release

```bash
bun run cli site build releases/RELEASE_ID --output public/RELEASE_ID
bun run site:validate public/RELEASE_ID
bun run cli site serve public/RELEASE_ID
```

`site build` verifies the source release and copies only allowlisted public data. Validate the
generated directory before serving or deploying it.

Built sites include the project license and the license notices emitted for bundled dependencies.
