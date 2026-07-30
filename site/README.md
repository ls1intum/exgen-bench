# Static evidence explorer

This directory contains a static client for precomputed public releases. The browser presents and
filters release data; it does not recompute estimates.

## Preview

```bash
bun site/validate.ts
bun site/serve.ts
```

Then open <http://localhost:4173>. Opening `index.html` directly is not supported because browsers
block local JSON requests.

## Release input

`data/catalog.json` lists immutable release manifests and selects a `default_release_id`. Each
release supplies:

- complete page metadata and precomputed aggregates in `release.json`;
- audit-oriented attempts in JSONL and an accessible CSV equivalent;
- metric cards; and
- checksums for downloadable artifacts.

The checked-in release is invented demonstration data, not a benchmark result. Public release and
attempt contracts are in [`schemas/protocol/`](../schemas/protocol/).

## Publishing a formal release

```bash
bun src/cli.ts publish-site releases/RELEASE_ID --output public/RELEASE_ID
bun site/validate.ts public/RELEASE_ID
bun site/serve.ts public/RELEASE_ID
```

Publishing verifies the source release and copies only allowlisted public data. Validate the
generated directory before serving or deploying it.
