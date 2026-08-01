# Hyperion development regression pack

## Intended use

This public dataset contains 19 heterogeneous exercise briefs taken verbatim from the former
Hyperion live browser evaluation. It measures one explicit input contract:

```text
exercise brief → candidate exercise
```

Use it for development, regression diagnosis, adapter integration, and evaluator calibration. Do
not use it for confirmatory claims about general exercise-generation quality. Every case is public
and has already informed Hyperion development, which is why it is the development pool of the
three-pool model in [`docs/METHODOLOGY.md`](../../docs/METHODOLOGY.md).

## Composition

| Dimension | Coverage |
| --- | --- |
| Difficulty | 4 introductory, 12 intermediate, 3 advanced |
| State | 13 stateless, 6 stateful |
| Brief specificity | 9 terse, 10 specified |
| Concepts | 18 distinct concepts across 19 cases; `state-machine` covers both `state-machine` and `robot-rover` |

[`tests/dataset-contract.test.ts`](../../tests/dataset-contract.test.ts) asserts these counts
against `dataset.yaml`, so the table cannot drift from the data.

The upstream file contained 28 scenarios. This pack keeps the 19 that use the single
brief-to-candidate contract and drops nine: one instructor-seeded statement
(`seeded-strategy-elevator`), three draft-only scenarios (`event-scheduler-conflicts`,
`warehouse-batch-allocation`, `transit-fare-ledger`), and five strategy-pattern prompts. Two pairs
of those five have byte-identical requirement text — `strategy-nodraft-spec` with
`strategy-nonstandard-v2`, and `strategy-authentic-exact-brief` with `strategy-nonstandard-theme` —
and `strategy-pattern-open` is a shorter form of the same task. The sixth strategy scenario,
`playlist-strategy-uml`, is retained as case `playlist-strategy`. The pack therefore preserves
useful inputs, not browser-flow parity.

`tags` are generator-visible and intentionally contain only `java`. Analysis-only coverage metadata
is under each case's `extensions`; it must not be copied into generation prompts.

### The pack mixes two instruments

Nine briefs are formulaic stubs of 165–225 characters that name a concept and close on a variant of
one clause ("Clearly describe the grouping rules and the ordering", "…each method", "…each
constant"). Ten name the data model, the algorithm, tie-breaking, or determinism constraints.
"Create an intermediate Java exercise about collections" asks whether a generation system can
*invent* an exercise; the playlist brief asks whether it can *comply* with a dense specification.
Pooling both into one exercise success rate confounds brief openness with system capability, so
`extensions.brief_specificity` records which instrument each case is, and the primary rate should
be reported stratified by it.

## Coding rules

| Field | Rule |
| --- | --- |
| `difficulty` | Copied verbatim from the upstream scenario's `complexity` field. Not assigned here. |
| `statefulness` | `stateful` when the brief requires a type that holds data between the calls that observe it; `stateless` when every required operation is a function of its arguments. |
| `brief_specificity` | `specified` when the brief names at least one concrete boundary, tie-break, or determinism obligation; `terse` when it only names a concept and asks for a clear description. |
| `primary_concept` | The single concept the upstream scenario was written to exercise. |
| `source_scenario_id` | The upstream scenario identifier, so the source can be relocated in any later upstream revision. |

`statefulness`, `brief_specificity`, and `primary_concept` are single-rater labels with no second
coder and no reported agreement. They are descriptive metadata for stratification, not validated
coding. An earlier `boundary_density` column was removed because no rule distinguished its levels.

## Provenance and license

**This repository is the authoritative copy.** All 19 briefs are reproduced here byte for byte
under `briefs/`, and generation reads only those files.

Each case's `origin.source_uri` links the upstream Playwright scenario file at the commit that
first introduced that brief, but every one of those commits sits on the unmerged Artemis branch
`hyperion-agentic-production-design` and may become unreachable when that branch is squash-merged or
deleted, so the links are a convenience reference rather than the provenance of record. Each case
also records `extensions.source_scenario_id`, which relocates the source in any later upstream
revision even after the commit is gone.

The briefs first appeared upstream in three commits: `d506bcfff8` on 2026-07-22 (four briefs),
`0bca64ee9d` on 2026-07-25 (nine), and `61fe1bdbb9` on 2026-07-26 (six). Each case's
`first_public_at` is the date of the commit that introduced its exact text, which is the earliest
date the text can be shown to have existed.

Source and dataset are both MIT under the same copyright holder, TUM Applied Education
Technologies; the repository [`LICENSE`](../../LICENSE) applies unchanged. The briefs are attributed
to Felix Timotheus Johannes Dietrich.

## Collection process

The briefs were written by the Hyperion maintainer as live end-to-end test inputs for Artemis
exercise generation, not as a benchmark corpus. They were selected for concept spread across an
introductory Java curriculum and for producing exercises a human could inspect quickly. No
instructor outside the project wrote or reviewed them, which is why the input contract is named
after the brief rather than after an instructor.

## Preprocessing and labeling

Retained briefs are byte-verbatim: no editing, truncation, or normalization was applied. Case IDs
were shortened from the upstream scenario IDs (`diverse-recursion` → `recursion`); the original is
kept in
`extensions.source_scenario_id`. The labels in `extensions` were assigned as described under
[coding rules](#coding-rules).

## Distribution

The dataset is distributed only as part of this repository, under MIT. It has no DOI, no persistent
identifier, and no Croissant metadata; [`CITATION.cff`](../../CITATION.cff) covers the software, not
this dataset. Cite it by repository commit until a release with a persistent identifier exists.

## Maintenance

The dataset is maintained by the exgen-bench maintainers at
[TUM Applied Education Technologies](https://aet.cit.tum.de/); use
[GitHub Issues](https://github.com/ls1intum/exgen-bench/issues) for corrections. `version` follows
semantic versioning: adding or removing a case is a major bump, relabeling `extensions` is a minor
bump, and prose-only changes are a patch. There is no deprecation policy yet, and superseded
versions are not archived separately.

## Limitations and governance

- The corpus is imbalanced toward intermediate cases and mixes two brief instruments.
- Public exposure and repeated use make contamination and overfitting likely.
- A separately authored, restricted validation set and a frozen sealed confirmatory set are
  required for inferential claims.
- A case permanently moves into development once its output, transcript, or evaluator result is
  used to change a generation approach.
- Version 1 has no case families. Every case is one sampling unit, and the paraphrase rule in
  [`docs/METHODOLOGY.md`](../../docs/METHODOLOGY.md) has nothing to constrain until a version with
  deliberate paraphrase variants exists.
- Hidden requirements, oracles, reference solutions, and semantic mutants belong only to the
  independently versioned evaluator suite.

This documentation covers the Datasheets for Datasets and Data Cards disclosure sections:
motivation, composition, collection process, preprocessing and labeling, uses, distribution,
maintenance, and limitations. See
[Datasheets for Datasets](https://doi.org/10.1145/3458723) and
[Data Cards](https://research.google/pubs/data-cards-purposeful-and-transparent-dataset-documentation-for-responsible-ai/).
