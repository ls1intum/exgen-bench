# Static evidence explorer

This directory contains a static client for precomputed public releases. The browser presents and
filters release data; it does not recompute estimates.

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

The checked-in release is invented demonstration data, not a benchmark result. Public release and
attempt contracts are in [`schemas/protocol/`](../schemas/protocol/).

## Build from a verified release

```bash
bun run cli site build releases/RELEASE_ID --output public/RELEASE_ID
bun run site:validate public/RELEASE_ID
bun run cli site serve public/RELEASE_ID
```

`site build` verifies the source release and copies only allowlisted public data. Validate the
generated directory before serving or deploying it.
