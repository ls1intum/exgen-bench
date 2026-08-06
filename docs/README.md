# Documentation

Choose the path that matches what you are trying to do.

## Get started

- [Project README](../README.md#get-started): preview the results site and verify the pipeline
  without credentials.
- [Run the stages yourself](../README.md#run-the-stages-yourself): inspect planning, execution,
  saved state, and evaluation with the small example.

## Run and integrate

- [System-under-test requirements](SUT-REQUIREMENTS.md): find out what your generation system must
  support, and at which conformance level, before a benchmark can measure it.
- [Protocol schemas](../schemas/README.md): connect a generation system through the language-neutral
  adapter interface, including generation protocol v2.
- [Artemis integration](ARTEMIS-INTEGRATION.md): understand the accepted Artemis and Hyperion
  boundary.
- [Process evaluators](PROCESS-EVALUATORS.md): run an out-of-process evaluator under its own
  version, bounds, and secret handling.
- [Results-site guide](../site/README.md): validate, build, preview, and publish release data.

## Datasets and studies

- [Hyperion development pack](../datasets/hyperion-development-v1/README.md): the 19 public exercise
  briefs, their provenance, coding rules, and limitations.
- [Hyperion development study](../studies/hyperion-development/README.md): the runnable smoke
  configuration and the live Artemis template.

## Understand the benchmark

- [System design](../SYSTEM-DESIGN.md): components, stored records, resume behavior,
  and release process.
- [Methodology](METHODOLOGY.md): what is measured and how formal comparisons are designed
  and reported.
- [Telemetry profile](TELEMETRY.md): what process evidence is captured, which claim it can support,
  and when a capture fails closed.
- [Reference pricing](REFERENCE-PRICING.md): report a dated OpenRouter catalog estimate without
  confusing it with provider billing.

## Reference and policy

- [Glossary](GLOSSARY.md): project terms and their corresponding protocol fields.
- [Corpora](../corpora/README.md): runs committed as produced, telemetry included, so evaluators can
  be developed and compared against real output.
- [Changelog](../CHANGELOG.md): changes to the generation, evaluation, dataset, and release
  contracts, and what an adapter or evaluator author has to do about them.
- [Restricted archives](RESTRICTED-ARCHIVES.md): packaging, verifying, and storing private run
  evidence.
- [Security policy](../SECURITY.md): trust boundaries, isolation requirements, and private
  vulnerability reporting.
- [Licensing and third-party material](../LICENSES.md): how project code, dependencies, and
  benchmark or result material are licensed, and what may be redistributed.
- [Citation metadata](../CITATION.cff): authorship and software citation information.

## Contribute

- [Contributing guide](../CONTRIBUTING.md): local setup, development checks, and project
  constraints.
- [Code of Conduct](../CODE_OF_CONDUCT.md): expectations for project participation.
