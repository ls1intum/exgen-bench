# Licensing and third-party material

## Project code

Unless a file states otherwise, original source code and documentation in this repository are
licensed under the [MIT License](LICENSE).

## Dependencies

Third-party packages retain their own licenses. `bun.lock` is the authoritative dependency snapshot
for a software revision. Inclusion in the lockfile does not relicense a dependency under MIT.

## Vendored site styles

The site keeps the MIT-licensed `shadcn` 4.16.0 Tailwind stylesheet under
[`site/vendor/shadcn-tailwind/`](site/vendor/shadcn-tailwind/NOTICE.md).
The file is copied without changes; its source, digest, and license are retained.
Built sites include its license in `third-party-licenses.txt`. The component-generator
CLI is not installed as a project dependency.

## Benchmark and result material

Material imported into or emitted by a benchmark may have rights and restrictions that differ from
the repository's software license. This includes:

- benchmark datasets or course exports;
- exercise briefs, reference solutions, hidden tests, rubrics, or semantic mutants;
- prompts, provider responses, or generated exercise artifacts;
- Artemis instances, plugins, containers, models, or external evaluation tools; or
- logos, trademarks, personal data, or institutional material.

Each released dataset and evidence bundle must carry its own license or rights statement, source
and transformation history, attribution requirements, intended use, and access classification.
Model-output rights can depend on provider terms and input rights.

No Artemis course export may be published without field allowlisting, de-identification, license
review, and confirmation that student or staff data is absent.

## Provider marks

Provider marks under `site/assets/providers/` come from
[Simple Icons](https://github.com/simple-icons/simple-icons/tree/fadc8239f9a45499f6a30e2dd5c73b84275e1ec7)
and the first-party Google and Mistral brand sites. They are used only to identify the provider of
an evaluated model. Simple Icons is distributed under CC0 1.0. The marks remain trademarks of their
respective owners and do not imply endorsement. Sources, retrieval details, digests, and notices are
recorded in [`site/assets/providers/README.md`](site/assets/providers/README.md).
