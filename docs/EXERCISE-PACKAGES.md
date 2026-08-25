# External exercise packages

An exercise package is the private-data boundary for complete reference exercises. It lets a data
owner keep exercise content in a separate repository while exgen validates and converts it into the
two layouts the benchmark already consumes:

- a protocol-v2 dataset containing only generator-visible briefs; and
- a restricted reference suite containing golden solutions and tests.

The package manifest is source-neutral. An Artemis export, another learning platform, or a curated
filesystem corpus can all be used after a source-specific importer has produced the same package
shape. No source-specific field enters the generation protocol.

## Manifest

`exercise-package.schema.json` is the public structural contract. Each case contains the ordinary
dataset provenance fields plus:

- `bundle`: a relative path to a complete candidate bundle with `response.json` and the required
  `problem_statement`, `template`, `solution`, and `tests` artifact roles;
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
├── references/<case-id>/{solution,tests}/
├── catalog.json
└── package-lock.json
```

The generated dataset records the package digest and adds `extensions.case_family` to each case.
Dataset extensions and package annotations remain analysis-side metadata: generation requests still
contain only the case ID, title, brief, and tags.

The package lock binds every brief, complete artifact bundle, and annotation file by digest. A
materialized reference directory can be passed as the `--suite` argument to `java-reference`.

## Repository boundary

Exercise packages may contain restricted course material. Keep their repository access-controlled.
The benchmark repository should contain only the schema, generic loader, and source-neutral examples;
it must not contain private manifests, paths, metadata, annotations, or exercise artifacts.
