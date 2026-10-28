# Survey server

The server of the expert rating survey: a Spring Boot 4 service on Java 25 and PostgreSQL 18. It
serves the built browser app and its JSON API, stores every answer, and writes the export the
analysis reads. Building and checking a study, and analysing its export, stay offline in
`exgen survey`; nothing here runs a study's exercises or reads exgen runs.

```sh
./gradlew check          # formatting (Spotless) and every test, against PostgreSQL in Docker
./gradlew bootRun        # the demo study on http://localhost:8080, with a local PostgreSQL
./gradlew spotlessApply  # format
```

## Layout

```text
exgen.survey             application, configuration (SURVEY_*), the study team's commands
exgen.survey.study       instrument, study and manifest, loading and verifying a frozen build,
                         and the rules an answer must meet
exgen.survey.rating      the rater's steps, the store (JdbcClient), the rater's and the study
                         team's services, and the JSON views of shared/api.ts
exgen.survey.export      the export archive: CSV tables, data.json and CODEBOOK.md
exgen.survey.web         controllers, the link cookie, security headers, legal documents
src/main/resources/db    the schema, as a Liquibase changelog
```

The browser app's contract is [`shared/api.ts`](../shared/api.ts); `Views` and `Requests` mirror
it, so the app needs no change when the server does. The rules of `AnswerRules` are those of
[`shared/instrument.ts`](../shared/instrument.ts), which the app applies first, and are tested
with the same cases.

## Configuration

Every property is set through the environment; `application.yml` holds the defaults for
development, `application-prod.yml` the container's layout.

| Variable                                             | Meaning                                                  |
| ---------------------------------------------------- | -------------------------------------------------------- |
| `SPRING_DATASOURCE_URL`, `_USERNAME`, `_PASSWORD`    | the PostgreSQL database                                  |
| `SURVEY_STUDY`                                       | the built study: `study.yaml` and `exercises/`           |
| `SURVEY_INSTRUMENT`, `SURVEY_WEB`                    | the instrument and the built browser app                 |
| `SURVEY_PUBLIC_URL`                                  | where raters reach the survey, for printed links         |
| `SURVEY_SECURE_COOKIES`                              | `false` only for a preview over plain HTTP               |
| `SURVEY_LEGAL_IMPRINT`, `_PRIVACY`, `_ACCESSIBILITY` | a URL, or a Markdown file the survey shows itself        |
| `SURVEY_LEGAL_REQUIRED`                              | refuse to start without imprint and privacy (`prod`: on) |

The same jar runs the study team's commands against the configured database:
`link --admin | --rater R1 …`, `withdraw --rater R3`, `export --output export.zip [--role main …]`.

## Tests

The tests run against a real PostgreSQL in Testcontainers.

- `ServerTest` drives the API as the browser app does: the order of steps and parts, refused and
  stale requests, the study team's endpoints, withdrawal, legal documents and the export.
- `SimulationTest` rates the study design's plan with seeded answers through the store and must
  reproduce [`analysis/example/data.json`](../analysis/example/data.json) byte for byte, which the
  analysis is pinned to. `bun run survey:example` rewrites it.
- `src/test/resources/study` is the demo study as `bun run survey:demo` builds it. After a change to
  the builder or the exercise format, copy `demo/study.yaml` and `demo/exercises/*.json` there again.
