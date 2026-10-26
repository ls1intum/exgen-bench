# Tier 3 expert rating

The survey tool for the expert study: instructors rate generated Artemis exercises from the view of
a teacher who decides whether to give the exercise to students. Their answers are the ground truth
the [Tier 2 judge](../tier2-judge/README.md) and the Tier 1 metrics are compared with.

Tier 3 is not an evaluator. It has no `tool.yaml`, so `exgen tools` does not list it and no
evaluation command runs it. It is run with `exgen survey`.

```sh
bun run survey:demo          # build and serve the synthetic demo study; prints one link per rater
```

## How a study runs

```text
data repository                                         survey server             results repository
study.yaml, exgen runs ──build──► exercises/ ──serve──► survey.sqlite ──export──► export.zip
                                                                                   └─report─► REPORT.md
```

1. **Generate and evaluate.** The exercises come from ordinary `exgen run` directories, evaluated
   with the Tier 1 deterministic tool (`exgen evaluate tool tier1-deterministic`). Published
   campaigns keep no run directories, so the build runs where the runs are.
2. **Define the study.** `study.yaml` in the data repository names the exercises, the calibration
   exercise and its reference answers, the raters and their plan, the consent text and the
   deadlines. [`demo/study.yaml`](demo/study.yaml) is a complete example.
3. **Build.** `exgen survey build <study>` turns each exercise into the material raters see and
   writes `exercises/<ID>.json`, `exercises/manifest.json` and `exercises/BLINDING.md` next to
   `study.yaml`. It refuses a candidate whose generation failed or that misses the java-oracle
   gates. Review every replacement in `BLINDING.md`, then commit the directory to the data
   repository: the manifest freezes every exercise by SHA-256, and the server refuses a file that
   changed afterwards. The study database records the digests, the plan and the instrument when it
   is created, so a later change to any of them is refused too: every answer in one database refers
   to the same material and wording.
4. **Check.** `exgen survey check <study>` validates the instrument version the study names, the
   plan, the calibration answers and, once built, the frozen files. It also runs before the build.
   `link` and `serve` run the same check and refuse to start on a problem.
5. **Invite and serve.** `exgen survey link <study> --db survey.sqlite --url https://… --rater R1`
   creates the study database on first use and prints a personal link; `--admin` prints the study
   team's link to the progress dashboard. `exgen survey serve <study> --db survey.sqlite` serves
   raters and the study team; the dashboard issues new rater links and assigns reserve raters.
   [`deploy/`](deploy/README.md) runs it in a container behind Caddy, with backups and withdrawals.
6. **Export and report.** The dashboard or `exgen survey export <study> --db survey.sqlite --output
export.zip` writes the answers as tidy CSV and JSON with a codebook. `exgen survey report
export.zip --output report/` applies the study design's analysis plan in a pinned R container
   ([`analysis/`](analysis/README.md)). Both go to the results repository.

Reserve raters complete the introduction and the practice exercise, then wait. From the dashboard,
the study team assigns them up to three exercises, either as a **backup** that takes over exercises
planned for a main rater who has not finished, and counts in that rater's place, or as a **tie
breaker** for an exercise whose two readiness ratings fall into different classes (ready 4–5,
usable 3, not usable 1–2).

## The instrument

[`instrument.yaml`](instrument.yaml) holds every question, option and instruction the tool shows;
[`INSTRUMENT.md`](INSTRUMENT.md) is generated from it by `bun run survey:instrument`, and a test
fails when the two differ. Answers are validated against the instrument on the server and in the
browser by the same code ([`shared/instrument.ts`](shared/instrument.ts)): every item is required,
a **No** needs its "where", and N/A exists only where an item offers it.

A rater moves through a fixed sequence: consent, background, onboarding, a practice exercise with
the study team's reference answers, then each planned exercise in four parts, and a final survey.
Declining consent is final for that rater ID.

| Part | Material it opens              | Items                                                            |
| ---- | ------------------------------ | ---------------------------------------------------------------- |
| A    | problem statement, brief       | clarity (CL1, CL2)                                               |
| B    | template, diff to the solution | solvability, objective alignment, difficulty fit, scaffolding    |
| C    | test overview with messages    | feedback quality (FB1), readiness before the findings (RD1)      |
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
from rater IDs to people outside the repository and outside the server. `exgen survey withdraw`
deletes a rater's answers at their request; the rater stays in the plan, marked as withdrawn.

The export contains `raters.csv`, `ratings.csv` (one row per rater and exercise, one column per
item, with the digest of the exercise shown), `background.csv`, `calibration.csv`, `exit.csv`,
`events.csv`, the same data with the instrument and the study's exercises as `data.json`, and
`CODEBOOK.md`. By default it covers main and reserve raters; pilot and test raters
are exported only on request (`--role`). CSV cells are escaped against formula injection. Free-text
answers are exported as written: remove identifying details before publishing.

## Security

- A personal link is exchanged once for an `HttpOnly`, `SameSite=Strict` session cookie, and the
  browser is redirected to `/`, so the token does not stay in the address bar or history. Issuing a
  new link revokes the holder's earlier one; for the study team, that is the only way to revoke a
  leaked link (`exgen survey link --admin`).
- Every change must be a JSON request from the server's own host. Behind a reverse proxy, forward
  the `Host` header unchanged.
- Every response carries a strict Content Security Policy: no inline scripts or style sheets, and
  inline style attributes only, which PlantUML's engine sets while drawing; and
  `Referrer-Policy: no-referrer`. Diagrams render in the page and are shown as images.
- The study team's endpoints require the study team's link.

Deploy behind a TLS-terminating reverse proxy and keep the default secure cookie, as
[`deploy/`](deploy/README.md) does. The server listens on `127.0.0.1` unless `--hostname` says
otherwise; `--insecure-cookies` exists only for a local preview over plain HTTP. Back up with
`exgen survey backup`, which writes a consistent copy while the server runs; copying the SQLite
file is not a backup, because recent writes sit in its WAL file.

## Development

```sh
bun run survey:demo                  # the demo study on http://127.0.0.1:4180
bun run survey:dev                   # Vite with hot reload on top of it, proxying /api and /r
bun run survey:instrument            # regenerate INSTRUMENT.md after editing instrument.yaml
bun run survey:example               # the analysis on simulated answers, into analysis/example/
bun test tests/survey*.test.ts       # instrument, plan, builder, store, server and export
bunx playwright test browser-tests/survey.spec.ts
```

The browser app uses the site's shadcn components and theme from `site/src`, so both look and
behave the same. The [demo](demo/README.md) is synthetic and CC0-licensed.

```text
instrument.yaml   the instrument; INSTRUMENT.md is generated from it
shared/           instrument, exercise, flow, plan and API types used by server and browser
builder/          study build: statement, diff, test overview, findings, blinding, manifest
server/           study loading, SQLite store, HTTP server, export, INSTRUMENT.md generator
web/              the browser app (Vite, React, Tailwind, shadcn)
analysis/         the analysis plan in R, its pinned container, a simulation and its report
deploy/           container image, Compose with Caddy, and the runbook for a study
demo/             a synthetic study with four exercises and test raters
```

## Not yet covered

- The Tier 2 judge's rubric is not yet aligned with the instrument's items, so the judge-to-expert
  comparison cannot run yet.
- The test overview holds the messages of the template run only, not those of faulty solution
  variants.
