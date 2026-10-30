# Tier 3 expert rating

The survey tool for the expert study: instructors rate generated Artemis exercises from the view of
a teacher who decides whether to give the exercise to students. Their answers are the ground truth
the [Tier 2 judge](../tier2-judge/README.md) and the Tier 1 metrics are compared with.

Tier 3 is not an evaluator. It has no `tool.yaml`, so `exgen tools` does not list it and no
evaluation command runs it. `exgen survey build | check | report` prepares a study and analyses its
answers; the [survey server](server/README.md), a Spring Boot service on PostgreSQL, runs it.

```sh
bun run survey:demo          # build and serve the synthetic demo study; prints one link per rater
```

The demo needs Docker, for its database, and JDK 25, for the server.

## How a study runs

```text
data repository                                         survey server            results repository
study.yaml, exgen runs ──build──► exercises/ ──serve──► PostgreSQL ──export──► export.zip
                                                                                 └─report─► REPORT.md
```

1. **Generate and evaluate.** The exercises come from ordinary `exgen run` directories, evaluated
   with the Tier 1 deterministic tool (`exgen evaluate tool tier1-deterministic`). Published
   campaigns keep no run directories, so the build runs where the runs are.
2. **Define the study.** `study.yaml` in the data repository names the exercises, the raters and
   their plan, the consent text and the deadlines the dashboard tracks. [`demo/study.yaml`](demo/study.yaml) is a complete example.
3. **Build.** `exgen survey build <study>` turns each exercise into the material raters see and
   writes `exercises/<ID>.json`, `exercises/manifest.json` and `exercises/BLINDING.md` next to
   `study.yaml`. It refuses a candidate whose generation failed or that misses the java-oracle
   gates. Review every replacement in `BLINDING.md`, then commit the directory to the data
   repository: the manifest freezes every exercise by SHA-256, and the server refuses a file that
   changed afterwards. The study database records the digests, the plan and the instrument when the
   server first starts, so a later change to any of them is refused too: every answer in one
   database refers to the same material and wording.
4. **Check.** `exgen survey check <study>` validates the instrument version the study names, the
   plan and, once built, the frozen files. It also runs before the build,
   and the data repository's CI runs it on every study. The server repeats the checks it relies on
   and refuses to start on a problem.
5. **Invite and serve.** The [survey server](server/README.md) serves raters and the study team.
   In its container, `survey link --rater R1` prints a personal link and `survey link --admin` the
   study team's link to the progress dashboard, which issues new rater links and assigns reserve
   raters. [`deploy/`](deploy/README.md) runs it behind the host's Traefik with its database, and
   describes backups and withdrawals.
6. **Export and report.** The dashboard or `survey export --output export.zip` writes the answers
   as tidy CSV and JSON with a codebook. `exgen survey report export.zip --output report/` applies
   the study design's analysis plan in a pinned R container ([`analysis/`](analysis/README.md)).
   Both go to the results repository.

`study.yaml` is the plan the study starts from, and the database freezes it. While the study runs,
the study team manages it from the dashboard, behind its own link:

- **Raters.** Add a rater of any role at any time, such as a second pilot rater or an expert who
  joins late; their link is shown once. Issue a new link, revoke one, move a deadline, or withdraw a
  rater at their request, which deletes their answers.
- **Assignments.** Assign any study exercise to any rater, in the order the rater rates them: as an
  **additional** rating, such as a pilot rating a study exercise; as a **backup** that stands in for
  another rater's planned rating, for example after a dropout; or as a **tie breaker** for an
  exercise whose two readiness ratings fall into different classes (ready 4–5, usable 3, not usable
  1–2). An assignment the rater has not started can be removed; it stays in the database, marked.
- **Overview.** Progress, rating time and last activity per rater, with overdue and inactive raters
  flagged; planned ratings and agreement per exercise; the median minutes of each part against the
  design's budget; and the raters' comments when looking back and on the briefs.
- **Changes.** Every change is logged with its time, shown on the dashboard and exported as
  `changes.csv`, so the deviations from the plan can be reported. A rater added to `study.yaml`
  after the first answer is logged the same way.

Each planned rating of a main rater counts once toward an exercise's planned ratings: the rater's
own, or a backup's while the rater's is missing. Pilot and test raters, and additional ratings, are
kept apart.

## The instrument

[`instrument.yaml`](instrument.yaml) holds every question, option and instruction the tool shows;
[`INSTRUMENT.md`](INSTRUMENT.md) is generated from it by `bun run survey:instrument`, and a test
fails when the two differ. Answers are validated against the instrument in the browser
([`shared/instrument.ts`](shared/instrument.ts)) and again on the server, which decides
(`exgen.survey.study.AnswerRules`), by the same rules and the same test cases: every item is
required, a **No** needs its "where", and N/A exists only where an item offers it.

A rater moves through a fixed sequence: consent, the introduction, background questions, each
planned exercise in four parts, a look back at the exercises, and feedback on the briefs, which lists only the briefs
of their assigned exercises, numbered to match their rating order. Declining consent is final for that rater
ID.

| Part | Material it opens              | Items                                                            |
| ---- | ------------------------------ | ---------------------------------------------------------------- |
| A    | problem statement, brief       | clarity (CL1, CL2)                                               |
| B    | template, diff to the solution | solvability, fit with the brief, scope, scaffolding              |
| C    | test overview with messages    | feedback (FB1), readiness before the findings (RD1)              |
| D    | automatic findings of Tier 1   | the findings (AF1, AF2), readiness after them (RD2), main change |

The server, not the browser, enforces the order. It sends a part's material only when the rater
opens that part, and it lets a rater open only the first part not yet submitted, so later material
never reaches the browser early and a submitted part cannot be changed. Answers are saved as a
draft while the rater types, and a rater can stop between parts and continue with the same link.

## What raters see of an exercise

The builder ([`builder/`](builder/)) reads the run's artifacts and journals and keeps only what an
instructor would see before deploying:

- the problem statement with its task markers, without the test names behind them, and its
  PlantUML diagrams in Artemis' colours and theme. The rater's browser draws them with PlantUML's
  own engine compiled to JavaScript ([`@plantuml/core`](https://www.npmjs.com/package/@plantuml/core)),
  loaded only for a statement with a diagram, so building needs no Java renderer and no diagram
  leaves the page;
- the template files without the clone's `.git/`, and the diff from template to solution over
  source files only;
- the template's failing tests and their messages, grouped by task, from running the java-oracle
  backend (`build.oracle`) on the template. Artemis `<testid>` references are resolved through the
  test cases the Artemis adapter recorded with the attempt;
- the findings of the deterministic evaluators `java-oracle`, `java-static`, `consistency` and
  `promise-traceability`, restated in plain language, one finding per kind of problem. No
  model-assisted, reference or judge result is shown, and findings are not filtered: whether they
  are correct is one of the questions.

`build.blinding` lists regular expressions whose matches are replaced by `[removed]` everywhere, so
the generator cannot be recognised. Keep them specific: a pattern for a generator's name can also
match exercise content, such as a book title, which `BLINDING.md` shows. Each exercise gets a random four-character ID; its code in
`study.yaml` (such as `E1`) is never shown to raters.

## Data and privacy

The database stores, per pseudonymous rater ID: answers and drafts, when each step was opened and
submitted, which material views were opened, and the instrument version. It stores no names,
e-mail addresses or IP addresses, and only SHA-256 digests of the personal links. Keep the mapping
from rater IDs to people outside the repository and outside the server. `survey withdraw --rater`
deletes a rater's answers at their request; the rater stays in the plan, marked as withdrawn.

The export contains `raters.csv`, `ratings.csv` (one row per rater and exercise, one column per
item, with the digest of the exercise shown), `background.csv`, `exit.csv`, `briefs.csv`,
`events.csv`, `changes.csv`, the same data with the instrument and the study's exercises as
`data.json`, and `CODEBOOK.md`. By default it covers main and reserve raters; pilot and test raters
are exported only on request (`--role`). CSV cells are escaped against formula injection. Free-text
answers are exported as written: remove identifying details before publishing. The server's
simulation must reproduce [`analysis/example/data.json`](analysis/example/data.json) byte for byte,
and the analysis reads nothing else.

## Legal documents and blinding

A deployment names its imprint, privacy notice and, optionally, accessibility statement:
`SURVEY_LEGAL_IMPRINT`, `SURVEY_LEGAL_PRIVACY` and `SURVEY_LEGAL_ACCESSIBILITY`, each a URL to link
to or a Markdown file the survey shows on its own page. Every page links to them in its footer,
the consent page points to the privacy notice, and they are readable without a personal link. The
`prod` profile refuses to start without an imprint and a privacy notice.
[`deploy/legal/`](deploy/legal/) holds neutral templates, which the demo shows.

Nothing in this tool names the institution that runs a study: the operator, its legal texts, the
study's title and contact, and the domain all come from the deployment and the study definition in
the data repository. A copy of this repository can therefore be published blinded for review.

## Security

- There are no accounts or passwords. A personal link holds a random 256-bit token; it is exchanged
  once for an `HttpOnly`, `Secure`, `SameSite=Strict` session cookie with the `__Host-` prefix, and
  the browser is redirected to `/`, so the token does not stay in the address bar or history.
  Issuing a new link revokes the holder's earlier one; for the study team, that is the only way to
  revoke a leaked link (`survey link --admin`).
- Every change must be a JSON request of at most 256 KiB from the server's own host, and every
  request body is validated field by field. Behind a reverse proxy, forward the `Host` header
  unchanged, as Traefik does.
- Every response carries a strict Content Security Policy: no inline scripts or style sheets, and
  inline style attributes only, which PlantUML's engine sets while drawing; and HSTS,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `X-Robots-Tag: noindex`. Diagrams render
  in the page and are shown as images.
- The study team's endpoints require the study team's link; without a link, the API answers every
  path with 401 and does not reveal which endpoints exist.
- The container runs as an unprivileged user on a read-only file system without capabilities; its
  health endpoint is reachable only from inside the container, and the database only from the
  survey, on a network without outside access.

Back up with `pg_dump` ([`deploy/`](deploy/README.md)), which writes a consistent copy while the
server runs.

## Development

```sh
bun run survey:demo                  # the demo study on http://127.0.0.1:4180 (Docker, JDK 25)
bun run survey:dev                   # Vite with hot reload on top of it, proxying /api and /r
bun run survey:instrument            # regenerate INSTRUMENT.md after editing instrument.yaml
bun run survey:example               # the analysis on simulated answers, into analysis/example/
bun run survey:server                # the server's formatting and tests (PostgreSQL in Docker)
bun test tests/survey*.test.ts       # instrument, plan and builder
bun run survey:browser-test          # the survey in three browsers, against the demo
```

The browser app uses the site's shadcn components and theme from `site/src`, so both look and
behave the same. The [demo](demo/README.md) is synthetic and CC0-licensed.

```text
instrument.yaml   the instrument; INSTRUMENT.md is generated from it
shared/           instrument, exercise, plan and API types of the builder and the browser app
builder/          study definition, check and build: statement, diff, tests, findings, blinding
server/           the survey server: Spring Boot, PostgreSQL, export, and the study team's commands
web/              the browser app (Vite, React, Tailwind, shadcn)
analysis/         the analysis plan in R, its pinned container, and its report on simulated answers
deploy/           container image, Compose behind Traefik, legal templates, and the runbook
demo/             a synthetic study with four exercises and test raters
```

## Not yet covered

- The Tier 2 judge's rubric is not yet aligned with the instrument's items, so the judge-to-expert
  comparison cannot run yet.
- The test overview holds the messages of the template run only, not those of faulty solution
  variants.

## Rebuild findings for a new feedback round

Copy the previous study to a new directory and set a new study ID. Keep the generated exercises
unchanged; rebuild only their findings from the original, published source bundles:

```sh
bun run src/cli.ts survey refresh-findings /path/to/new-study \
  --archive /path/to/published-candidates --report /private/path/build-report.json --rebuild
bun run src/cli.ts survey check /path/to/new-study
```

The archive must contain `MANIFEST.json` with the original run and attempt IDs and SHA-256 of every
source file. Every file is checked before it is used. A report belongs outside the study directory.
The command reruns template and solution gates, compiler diagnostics, coverage, code-change probes,
and configured constraint probes. It writes new frozen hashes only when all exercises finish.
Deploy the new study with a fresh database; keep previous responses and consent separately.

The Gradle profile requires a JDK compatible with the generated code (JDK 25 for campaign 26).
JaCoCo 0.8.14 is pinned and attached through an init script. Compiler warnings are measured on a
separate copy with standard warning suppressions disabled; original source and test executions
are unchanged. The build report records the detailed measurements and toolchain.

### What participants see

The default report has three neutral categories: **Consistency**, **Solution** and **Tests**.
Each shows its finding count or **None reported**, followed by short observations with their original
F IDs. Categories organise evidence; they are not automated quality ratings. No cognitive-demand,
learning-value or readiness score is inferred from source size, coverage or mutations.

One **Evidence and measurements** disclosure retains every original finding title, evidence string
and measurement. Code locations, snippets, requirement quotes and technical explanations do not
compete with the observations in the initial view. Unknown check families remain visible without
invented interpretations. An unreported finding is not a claim that the category was fully checked.

Generic type diagnostics cover collections and other generic APIs. Surviving edits retain the
qualification that they may be valid alternatives. Coverage observations identify code left
unexecuted without declaring it an error; entry points may be outside the graded task.

The fixed policy excludes weak absence heuristics, assertion density, raw complexity and style-only
checks as defect claims. No model-assisted or Tier 2 output is included. External models may review
the design/code; they do not produce participant findings.

### Presentation provenance

`categories-v1` identifies the compact presentation separately from instrument version 4 and the
frozen exercise digests. The browser sends `X-Survey-Presentation`; Part D records distinct reported
presentations and the ID at submission. Existing opened/submitted Part D material is backfilled as
`legacy-unversioned`, without claiming an exact retrospective UI version. Resuming an opened step
with another presentation preserves both IDs and exports a mixed-exposure flag. These records
identify reported client/material delivery, not whether a participant read or understood it.

Existing consent, responses, drafts, assignments and personal links stay intact. Changing report
wording after release requires a new presentation ID and a corresponding copy snapshot. Continue
accepting previously released IDs so cached browser tabs can still submit. Do not pool
mixed exposures or different presentation conditions in one analysis: the analysis entry points
reject that input and require separate documented datasets. Keep the original export unchanged.

Deployment verification must not visit an active rater's Part D simply to test a link: that would
introduce an artificial exposure. Use an isolated database for full rating flows and verify active
production links read-only, without delivering their material.

### Automatic coding-constraint checks

The builder and `refresh-findings` use the same rule set on every exercise, without exercise IDs,
class names, method names or campaign-specific finding text. Coverage and mutation checks use the
template-to-solution diff. Compiler warnings come from the Java compiler.

Constraint checks automatically recognise explicit English instructions such as
`Implement tally as a single stream pipeline` and `Implement search with a while loop`.
They retain the instruction as evidence and scope a named instruction to that method. Examples,
code fences, optional suggestions and negated instructions do not establish a requirement.
Other wording may remain undetected; absence of a recognised requirement is not a successful check.
The legacy `build.constraints` field is optional and cannot invent requirements: every configured
construct must also have a recognised explicit instruction in the statement.

`stream_api` currently supports a single `stream().filter(...).count()` or
`stream().filter(...).map(...).toList()` return pipeline and replaces it with a loop.
`while_loop` replaces `while (condition)` with `for (; condition;)`. These are bounded syntactic
transformations, not a complete Java rewriting engine. Unsupported forms are labelled as unmeasured.
A finding is emitted only when the replacement compiles and the complete original test set passes.
It shows an accepted implementation without the required syntax; it does not prove equivalence for
every input or assess teaching quality.

### Reading the test measurements

- **Solution lines reached by tests:** executable solution lines added or changed from the template.
  Reaching a line does not establish that its result was checked.
- **Decision outcomes reached by tests:** measured outcomes of conditions on those lines, such as
  true and false. This is neither a test count nor all possible input combinations. JaCoCo does not
  count exception handling as branches.
- **Modified solutions rejected by tests:** each selected version changes one operation, such as
  `>` to `>=`. A rejection requires a reported failing test. Non-compiling, unfinished and timed-out
  runs are excluded and reported separately. The default selects at most 16 variants, spread over
  methods and operators; a perfect result applies only to that sample.

Each measurement carries an explanation in the generated study. The survey also explains frozen
studies that predate these descriptions, using the same shared wording. No issue detected is a
neutral result, never a claim that an exercise is correct.

Definitions: [JaCoCo counters](https://www.jacoco.org/jacoco/trunk/doc/counters.html) and
[PIT mutation-testing concepts](https://pitest.org/quickstart/basic_concepts/). The implementation
uses the recorded JaCoCo version and source mutation operators; it does not claim to run PIT.
