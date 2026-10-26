# Analysis

[`analysis.R`](analysis.R) applies the analysis plan of the study design (Section 8) to the
`data.json` of an `exgen survey export` and writes `REPORT.md` with one CSV per table in `tables/`.
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
| Pilot               | median minutes per part and per exercise                                                                                        | timestamps of the survey                                                                        |

Planned ratings are those of main raters plus backups that stand in for them; tie-breaker ratings
only classify exercises, and pilot and test raters are not part of a default export. Intervals are
95 % percentile intervals from 2,000 resamples of exercises, with the seed 20261026.

What the report leaves out, on purpose:

- **SQ4** needs the LLM judge's verdicts on the same items and the automatic metrics per exercise.
- **Free text** (the "where" answers, the most important change, AF2's reasons) is coded by two
  researchers in a thematic analysis; the report only counts it, so no free text reaches it.
- **The mixed model** may not converge with 24 ratings. The report then says so and, as the plan
  states, stands on the descriptive results; it does not switch to another model.

## Example

[`example/`](example) holds the report of a simulated study ([`simulate.ts`](simulate.ts)): the
plan of the study design, one main rater who stops after the first exercise and a backup who takes
over, and a tie breaker. The answers follow a simple model in which exercises differ in quality and
raters in severity; they are not evidence about anything. The example shows the report before any
rater answers, and CI regenerates it with `bun run survey:example --check`, so a change to the
simulation, the analysis, or the pinned packages cannot go unnoticed.
