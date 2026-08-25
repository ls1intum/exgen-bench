# External exercise packages

An exercise package is the private-data boundary for complete reference exercises. It lets a data
owner keep exercise content in a separate repository while exgen validates and converts it into two
metric-independent interfaces:

- a protocol-v2 dataset containing only generator-visible briefs; and
- a restricted reference set containing complete exercise bundles.

The package manifest is source-neutral. An Artemis export, another learning platform, or a curated
filesystem corpus can all be used after a source-specific importer has produced the same package
shape. No source-specific field enters the generation protocol.

## Manifest

`exercise-package.schema.json` is the public structural contract. Each case contains the ordinary
dataset provenance fields plus:

- `bundle`: a relative path to a complete candidate bundle with `response.json` and the required
`problem_statement`, `template`, `solution`, and `tests` artifact roles. Additional declared roles,
such as platform metadata and assets, remain part of the reference rather than being discarded;
- `family_id`: the sampling family when several cases are variants of one underlying exercise; and
- `annotations`: an optional opaque annotation file. Exgen authenticates the file but never exposes
  or interprets its contents.

All referenced paths must remain below the manifest directory. Absolute paths, traversal, symbolic
links, duplicate case IDs, incomplete bundles, and malformed generation responses are rejected.

## Validate and materialize

```sh
bun run cli data validate ../private-data/package.yaml

bun run cli data materialize ../private-data/package.yaml \
  --output ../private-data/materialized
```

Materialization writes a new directory atomically. It refuses to overwrite an existing path and
produces:

```text
materialized/
├── dataset.yaml
├── briefs/<case-id>.md
├── reference-set.yaml
├── reference-bundles/<case-id>/
│   ├── response.json
│   └── <every declared artifact>
├── catalog.json
└── package-lock.json
```

The generated dataset records the package digest and adds `extensions.case_family` to each case.
Dataset extensions and package annotations remain analysis-side metadata: generation requests still
contain only the case ID, title, brief, and tags.

The package lock binds every brief, complete artifact bundle, response manifest, and annotation file
by digest. `reference-set.yaml` maps case identities to those complete, content-addressed bundles
and carries its own reproducible digest. A data-backed evaluator must use that reference-set digest
as its evaluation-suite identity, so changing a bundle cannot silently reuse an evaluation journal.
It contains no evaluator identity, requested metric, threshold, execution command, or metric-specific
projection. An evaluator may consume the reference-set contract and select the roles it understands;
evaluator selection and metric configuration belong to the benchmark study or evaluation run.

This direction is deliberate:

```text
source importer -> exercise package -> dataset + reference set -> evaluator -> metrics
```

The data side depends only on versioned structural contracts. Evaluators depend on the reference-set
contract; the contract never imports or names an evaluator.

## Repository boundary

Exercise packages may contain restricted course material. Keep their repository access-controlled.
The benchmark repository should contain only schemas, generic loaders, and source-neutral examples;
it must not contain private manifests, paths, metadata, annotations, package digests, or exercise
artifacts. A private suite binding is created as run configuration outside the data package; it is
not committed back into the data repository.
