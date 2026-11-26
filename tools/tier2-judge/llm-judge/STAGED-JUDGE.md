# Staged Expert Study judge

The staged judge answers the Expert Study questionnaire (instrument 7) with a language model, using
the study's blinded exercise documents and the same staged release of material as the survey. It is
the judge the study protocol compares with the instructors' ratings.

It is **separate from the Tier 2 protocol worker** in [`worker.ts`](worker.ts). That worker receives
exgen run artifacts through evaluation protocol v1, not the blinded survey material, and still
reports every `judge.*` metric as `not_applicable`. Running `exgen evaluate tool tier2-judge` does
not run this judge and measures nothing.

## Run it

```sh
# Write the prompts of the A, B, C and D-RD2 calls without contacting any model.
bun run tools/tier2-judge/llm-judge/staged/cli.ts preview \
  --exercises <study>/exercises --output <empty directory>

# Judge with an OpenAI-compatible endpoint.
cp tools/tier2-judge/llm-judge/staged/judge.example.yaml judge.yaml   # set base_url and model
export EXGEN_JUDGE_API_KEY=...                                         # the name api_key_env gives
bun run tools/tier2-judge/llm-judge/staged/cli.ts judge \
  --config judge.yaml --exercises <study>/exercises --output <empty directory>
```

`--exercise FILE` (repeatable) selects single exercises, `--instrument-version` (default `7`) the
instrument, and `--model` and `--base-url` override the configuration. The credential is read only
from the environment variable named by `provider.api_key_env`; it never appears in configuration,
records or error messages. `manifest.json`, which holds provenance, is never read. Exit status 0
means every call was answered, 2 that the run finished with at least one call that was not, 1 a
usage or input error.

## What each call sees

Four calls per exercise, each a new conversation:

| Call    | Items         | Material                        |
| ------- | ------------- | ------------------------------- |
| `A`     | SPEC          | Problem statement, starter code |
| `B`     | GOAL, SUPPORT | + Prompt, solution changes      |
| `C`     | FEEDBACK, RD1 | + tests                         |
| `D-RD2` | RD2           | + findings and measurements     |

- **Material** is what the instrument's `material` lists open up to the part (`materialThrough`),
  rendered as text the way the rating screen shows it: task rows and PlantUML diagram source from
  the statement, the starter tree grouped by `groupStarterFiles` (shared with the survey), the
  diff with line numbers, the test overview as `Tests.tsx` shows it (outcome on the template, wrong
  variants, "No message", shared messages, tests not linked to a task), and findings through the
  shared `studyFindingsReport`. Labels and captions are the survey's `STUDY_MATERIAL_LABEL` and
  `STUDY_MATERIAL_CAPTION`. The same finding IDs, evidence, review cues and check limits are available
  in both views. The Judge receives the expanded text. In the survey, reviewers can open longer
  evidence and measurements and follow links to the existing material tabs.
- **Never shown:** `facts`, the exercise ID, test `generic` flags, finding `severity`, provenance,
  hidden tests, test code, the sample solution beyond the diff, any human answer. The "M" marker
  for files the solution changes appears only from B, when the diff is open. Binary files are
  absent from the study documents and skipped if present.
- **Build and setup files** stay closed: the call lists their paths and may ask once for up to
  `setup_reads.max_files` of them (`{"read_setup_files": [...]}`), only from its own stage's setup
  group. Any other path, a second request, or a request when none was offered makes the output
  invalid. The files read are recorded.
- **Guidance** comes from the canonical instrument. This includes the introduction, materiality
  rule, perspective, opening text, questions, options and follow-ups. The Judge always receives the
  readiness examples with RD1 and RD2. Human reviewers can open the same examples beside those
  questions. The Judge's additional instructions cover JSON output and evidence locators.

## Answers and failures

The model replies with `{"answers": {"<ITEM>": {"value", "choice"?, "text"?, "evidence_refs"?,
"rationale"?}}}`. Its answers are checked by the survey's own `answerIssues` against exactly the
call's items (value must be the instrument's option value, including its JSON type; follow-up
choices and detail text where the option asks for them; no item of another call), then by the
judge's evidence rules: at most two locators, each naming material of that stage (`statement:L3`,
`brief:L2`, `file:<path>:L10-L12`, `diff:<path>:L9`, `task:<title>`, `test:<name>`, `finding:F1`,
`measurement:<label>`, `material:<kind>`), and at least one when the option asks for a detail.
Accepted answers are stored as `normalizeAnswers` would store a rater's. Missing and invalid
locators are recorded on their item under `evidence_issues`. They leave the survey-valid answer
available for comparison. Verify whether the cited material actually supports the claim.

Nothing is repaired. Each call ends in one state:

| State            | Meaning                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `answered`       | Every item valid. `cannot_assess` and `na` are valid answers like any other.                                                                                             |
| `invalid_output` | Not one JSON object, wrong shape, an answer the survey would reject, or a bad file request. Not retried.                                                                 |
| `model_error`    | Transport failure, HTTP error, empty content, or a reply cut off at the token limit. Network errors, timeouts, 408/409/425/429 and 5xx are retried up to `max_attempts`. |

## Records

The output directory must be empty. It receives:

- `<ID>.judgement.json`: every call with its exact messages (the snapshot), every attempt with the
  provider's request ID, reported model, finish reason and usage, the issues, the accepted answers,
  rejected answers kept for diagnosis, the setup files read, and digests: `evidence_sha256` (the
  material the stage makes available, the same for every rater of that stage), `prompt_sha256`
  (the opening messages), plus `rubric_sha256` and `exercise_sha256`.
- `rows.jsonl`: one row per item with `rubric_version`, `exercise_id`, `part`, `call`, `item_id`,
  `status`, `answer`, `evidence_refs`, `evidence_issues`, `rationale`, the digests and the models that answered.
- `run.json`: judge, rubric and presentation versions, the SHA-256 of `rows.jsonl`, transport (provider host,
  requested model, parameters), retry and setup-read settings, and the status of every call.

`STAGED_JUDGE_VERSION` versions the judge's instructions and call sequence, `TEXT_PRESENTATION_VERSION`
the text rendering, and `STUDY_FINDINGS_PRESENTATION_VERSION` the main-study findings report. If the survey's
`Tests.tsx`, `Findings.tsx`, `Template.tsx` or `Markdown.tsx` change what raters see, the text
rendering in `staged/material.ts` must change with them.

For the matching human–Judge report, pass the staged run directory to the analysis:

```sh
exgen survey report main-export.zip --judge staged-judge-run --output report/
```

The run records the byte digest of each loaded exercise file separately from the canonical
content and staged evidence digests. The report checks the raw file digest, shared rubric and findings presentation. It verifies
the rows against the run manifest before comparing answers. Full-study runs should cover all
frozen exercises. The report shows missing exercises and failed items explicitly.

The Judge answers RD2 in a fresh call. Humans choose RD2 before they can reopen RD1. They can
remember RD1 and revise after reopening it. The report shows how often the submitted choice
differed from the value at the first recorded opening. Compare results within each stage. A
change across Judge calls includes variation between independent inferences.

Reviewers alone answer FIND and FLAG about their experience with the automatic report, and
the survey feedback questions at the end of the session.
