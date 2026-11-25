# Analysis

[`analysis.R`](analysis.R) applies the analysis plan of the study design (Section 8) to the
`data.json` of the survey server's export and writes `REPORT.md` with one CSV per table in `tables/`.
It runs in a container that pins R 4.6.1 and its packages to a dated CRAN snapshot
([`Dockerfile`](Dockerfile)), so the same export always gives the same report, byte for byte.

```sh
bun run cli survey report export.zip --output report/            # needs Docker
bun run cli survey report export.zip --output report/ --check    # fails if report/ is stale
```

| Section of the plan | What the report holds                                                                                                           | Method                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 8.1 Readiness       | share of planned ratings per class for RD1 and RD2; the class of each exercise                                                  | classes fixed before data collection; tie breaker by the median of three, else the lower rating |
| 8.2 SQ1             | share of Yes per item and per dimension; RD1 and RD2 per course phase; `RD ~ phase + position + (1 \| rater) + (1 \| exercise)` | cluster bootstrap over exercises; `ordinal::clmm`                                               |
| 8.3 SQ2             | agreement and Gwet's AC1 per item and pooled; Krippendorff's ordinal alpha and agreement within one level for RD1 and RD2       | [`irrCAC`](https://cran.r-project.org/package=irrCAC) by Gwet                                   |
| 8.4 SQ3             | RD2 − RD1 per rating, changed decisions, Wilcoxon signed-rank test; AF1 and AF2 answers                                         | base R                                                                                          |
| Pilot               | median minutes per part, per exercise, and per session, over every complete rating                                              | timestamps of the survey                                                                        |

Planned ratings are those of main raters plus backups that stand in for them; tie-breaker ratings
only classify exercises, and pilot and test raters are not part of a default export. Export a pilot
with `--role pilot`: its report shows only the times, which are the pilot's criteria. Intervals are
95 % percentile intervals from 2,000 resamples of exercises, with the seed 20261026.

What the report leaves out, on purpose:

- **SQ4** needs the LLM judge's verdicts on the same items and the automatic metrics per exercise.
- **Free text** (the "where" answers, the most important change, AF2's reasons) is coded by two
  researchers in a thematic analysis; the report only counts it, so no free text reaches it.
- **The mixed model** may not converge with 24 ratings. The report then says so and, as the plan
  states, stands on the descriptive results; it does not switch to another model.

## Instrument version 7

An export whose questionnaire asks `FIND` is analysed by [`analysis-v7.R`](analysis-v7.R), following
the V7 study protocol; exports of versions 4 to 6 keep the report above, byte for byte. V7 asks
`SPEC` (Part A); `GOAL`, `SUPPORT` (B); `FIT`, `FEEDBACK`, `RD1` (C); `RD2`, `GRADE`, then `FIND` (D).
Every item keeps its own categories from the exported instrument. `na` and `cannot_assess` are answers
of their own; a planned place without a complete rating is a missing rating, not an answer.

| Protocol question | What the report holds                                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Denominators      | per item: planned places, complete ratings, missing ratings, Cannot assess, N/A, assessable; every answer per item                                                                                                                                                        |
| SQ1               | RD1 and RD2 on five levels per course phase with the classes 4–5, 3 and 1–2; both original RD2 ratings per exercise, the pair at the 3/4 threshold (both 4–5, split, both 1–3, incomplete), a tie breaker beside them, and the lower RD2 as a marked operational decision |
| SQ2               | per item on exercises with both planned ratings: same answer, same answer among assessable pairs, and every answer combination; for readiness, same level, within one level, and pairs across 2/3 and 3/4                                                                 |
| SQ3               | RD1 × RD2, change by exercise position, first recorded opening of RD1, GRADE by readiness, and FIND by the direction of change                                                                                                                                            |

A planned place is filled by its main rater's complete rating, or else by the backup that stands in
for that rater on the same exercise. A backup whose main rater also finished, additional ratings,
incomplete ratings and tie breakers are counted in the header and never fill a place. The report
refuses, instead of guessing: completed ratings of another instrument version, values the
instrument does not offer, more than two planned ratings for an exercise, and a study that does not
plan two ratings per exercise.

The report gives counts on the chosen exercises. The study team codes free text and audits the
individual findings separately. Compare the staged Judge using the command below. The test [`survey-analysis-v7.test.ts`](../../../tests/survey-analysis-v7.test.ts) runs a
synthetic V7 export through the container: `EXGEN_SURVEY_ANALYSIS=1 bun test tests/survey-analysis-v7.test.ts`.

## Findings presentation conditions

A presentation update changes what raters see in Part D even when the questions and frozen
exercise evidence stay the same. The report refuses to pool completed ratings from multiple
presentation conditions or a rating with mixed reported exposures. Both the CLI and direct R
entry point enforce this check; no observations are automatically filtered or rewritten.

Keep the source export intact. Prepare documented analysis inputs for each presentation condition
and review mixed exposures separately. `findings_presentations` records the distinct reported
client IDs, `findings_presentation_at_submit` records the submitting client, and
`findings_presentation_mixed` marks more than one reported ID. They describe reported client/material
responses, not proof a person looked at the screen. Old exports without these fields remain
analysable as `legacy-unversioned` for backward compatibility. That is an unknown historical
bucket: it may contain several earlier UIs and does not establish a homogeneous treatment. The
report states this limitation; accepting an old export does not validate its comparability.
Incomplete ratings do not determine the report's presentation condition. The report lists its
single condition in its provenance.

## Example

[`example/`](example) holds the report of a simulated study (the survey server's
[`SimulationTest`](../server/src/test/java/exgen/survey/SimulationTest.java), which rates through the
server's own database and export): the
plan of the study design, one main rater who stops after the first exercise and a backup who takes
over, and a tie breaker. The answers follow a simple model in which exercises differ in quality and
raters in severity; they are not evidence about anything. The example shows the report before any
rater answers. CI regenerates the report with `bun run survey:example --check`, and the server's
tests fail when the simulation no longer reproduces `example/data.json`, so a change to the
simulation, the export, the analysis, or the pinned packages cannot go unnoticed.
`bun run survey:example` rewrites both.

To include SQ4 for instrument 7, pass the output directory from one staged Judge run:

```sh
exgen survey report main-export.zip --judge staged-judge-run --output report/
```

The report verifies each Judge input against the frozen file digest recorded in the participant
export and checks that `rows.jsonl` matches the digest in `run.json`. It reports exact agreement
on the same assessable human pairs and counts missing runs, failed model calls, abstentions and
N/A separately. Review grading faults and evidence references separately.
