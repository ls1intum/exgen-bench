# External exercise packages

An exercise package is the ingestion boundary for an exercise collection stored outside this
repository. Source-specific importers normalize Artemis exports, curated files, or other sources to
one manifest. Exgen can then validate the collection and materialize two metric-neutral interfaces:

- a benchmark dataset containing generator-visible briefs; and
- a reference set containing complete reference exercises.

## Manifest

`exercise-package.schema.json` is the structural contract. A package has one lifecycle status:

- `wip`: cases may contain briefs, annotations, and source material without complete bundles; or
- `ready`: every case has a complete reference bundle and the package can be materialized.

Each case contains normal dataset provenance fields and may add:

- `bundle`: a relative path to a complete bundle in generation-response layout, including
  `problem_statement`, `template`, `solution`, and `tests`; required for a ready package;
- `family_id`: an explicit sampling family for genuine variants of one exercise; omitted cases
  default to their own ID;
- `annotations`: an opaque file whose bytes contribute to the package digest but never enter a
  generation request or reference set; and
- `sources`: role-labelled authoring inputs whose bytes contribute to the package digest but are not
  copied into materialized output.

Referenced paths must remain below the manifest directory. Validation rejects absolute paths,
traversal, links, duplicate case IDs, incomplete ready bundles, and malformed generation responses.

## Validate and materialize

```sh
bun run cli exercise-package validate ../exercise-data/package.yaml

bun run cli exercise-package materialize ../exercise-data/package.yaml \
  --output ../exercise-data/materialized
```

Materialization accepts only ready packages, writes atomically, and refuses to overwrite an existing
path. It produces:

```text
materialized/
├── dataset.yaml
├── briefs/<case-id>.md
├── reference-set.yaml
└── reference-bundles/<case-id>/
    ├── response.json
    └── <declared artifacts>
```

The generated dataset records `extensions.case_family`. The request's `case` object still contains
only the case ID, title, brief, and tags. Package-only annotations and sources do not enter dataset
or reference-set identity.

Validation reports a package digest covering the manifest and every referenced brief, bundle,
annotation, and source input. The materialized reference set separately pins each complete bundle
and has its own reproducible digest. Reference-aware evaluators bind that digest as their suite
identity; annotations cannot silently alter an evaluation, and changing reference bytes cannot
silently reuse its journal. The reference-set contract contains no metric, threshold, evaluator, or
execution configuration.

```text
source importer -> exercise package -> dataset -> generation system -> candidate
                                  \-> reference set --------------------/
candidate + optional reference set -> evaluator -> metrics
```

The package contract depends only on source-neutral data formats. Generation systems consume
datasets. Evaluators consume candidates and, only when needed, reference sets.

## Repository boundary

Access control is a repository policy, not a property of the package format. Do not commit
restricted package content, paths, identifiers, or annotations to this repository. Synthetic test
fixtures are allowed under the rules in [LICENSES.md](../LICENSES.md). A study binds an external
reference set through run configuration; that binding is not written back into the data package.
