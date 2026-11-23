# Running the survey for a study

This runbook takes a built study from the data repository to a public HTTPS survey, keeps its
answers safe while it runs, and ends with an export for the results repository. The survey and its
PostgreSQL run with Docker Compose ([`compose.yaml`](compose.yaml)) behind the host's shared
Traefik, which obtains the TLS certificate. This repository builds the survey's image; the data
repository's thin release workflow calls this repository's reusable deployment workflow.

```text
exgen-bench (this repository)                 data repository (the study)
  main ──Survey image──► ghcr.io/…/survey:sha-<commit>
                                     │        studies/<study>/  deploy/  ──Deploy survey──► VM
                                     └────────────────────────────────────────────────────►  /opt/exgen-survey
                                                                                              ├─ compose.yaml, .env
                                                                                              ├─ study/  (read-only)
                                                                                              └─ legal/  (read-only)
```

## Deployment ownership and connection

`exgen-bench` owns the survey image, Compose files, and the reusable
[deployment workflow](../../../../.github/workflows/deploy-survey.yml). The private data repository
owns frozen studies, legal documents, environment variables/secrets, and a thin manual release
workflow. The private results repository owns exports and analysis; publication is a separate step.
Personal links, identities, credentials, and database backups stay outside Git.

The reusable workflow runs on a repository-scoped self-hosted runner on the survey VM, labelled
`survey-exgen`, under a dedicated `github_deployment` account with Docker access and no sudo.
Register this runner only with the trusted private data repository. Its PR validation continues on
GitHub-hosted runners; only manual deployments from `main` select the VM runner. The runner needs
outbound HTTPS to GitHub, but deployment needs no inbound SSH from GitHub Actions or gateway key.
Pin both the reusable workflow and its `tooling-ref` input to the same exgen-bench commit.

This matters on GitHub Free: organization secrets/variables are unavailable to private repositories,
even when the API lists them. A hosted-runner deployment through the organization's shared workflows
instead needs repository-scoped gateway configuration, including its SSH key.

The included `traefik.yaml` uses **Let's Encrypt** with HTTP-01 validation on public port 80,
automatic renewal, and persistent `acme.json` (mode 600). The resolver retains the legacy name
`harica` for compatibility with the survey Compose file; its issuer is explicitly Let's Encrypt.
The shared organization's HARICA workflow is an alternative that requires its own EAB credentials.

## What you need

- A VM with Docker Engine and the Compose plugin, reachable on ports 80 and 443, and a DNS name for
  the survey that points to it.
- **Approval for public access.** A survey that experts outside the institution's network reach is
  exposed to the Internet; the institution's IT may require a review of this deployment first. This
  runbook, [`compose.yaml`](compose.yaml) and the server's [security notes](../README.md#security)
  are what such a review reads.
- A certificate contact (`ACME_EMAIL`) and public access to port 80 for Let's Encrypt validation.
- An imprint and a privacy notice for the deployment: a URL each, or Markdown files in the data
  repository's `deploy/legal/`. [`legal/`](legal/) holds templates; the privacy notice must name
  the study's legal basis, retention and contacts, so check it with the data protection officer.
- A study whose exercises are built and checked (`exgen survey check` reports "The study is
  ready."), committed to the data repository, and an image of this repository at a commit whose
  instrument version the study names.

## Set up the deployment

In the data repository, create a GitHub environment (for example `Survey`) with:

| Kind     | Name                                           | Value                                                 |
| -------- | ---------------------------------------------- | ----------------------------------------------------- |
| variable | `SURVEY_HOST`                                  | the survey's DNS name, such as `survey.example.org`   |
| secret   | `POSTGRES_PASSWORD`                            | a random password, for example `openssl rand -hex 32` |
| variable | `SURVEY_LEGAL_IMPRINT`, `SURVEY_LEGAL_PRIVACY` | a URL, or `/legal/<file>.md` from `deploy/legal/`     |
| variable | `SURVEY_LEGAL_ACCESSIBILITY`                   | optional, as above                                    |
| variable | `ACME_EMAIL`                                   | contact for the Let's Encrypt account                 |

The deployment account needs Docker access and write access to `/opt/traefik` and
`/opt/exgen-survey`. The deploy script writes only the survey's required configuration to `.env`,
with mode 640; it never copies unrelated secrets. It refuses to replace an existing study with
different material, so another study needs a fresh deployment/database.

## Deploy

1. Wait for the **Survey image** workflow of this repository to build the commit you want; its
   image is `ghcr.io/ls1intum/exgen-bench/survey:sha-<7-character commit>`, with a build
   provenance attestation (`gh attestation verify oci://<image> --owner ls1intum`). The workflow
   runs for every change on `main` and on demand for another branch. The package must be public,
   so the VM pulls it without credentials; check this once in the package's settings.
2. In the data repository, run the **Deploy survey** workflow with the study directory, the image
   tag, and, on the first deployment, _Deploy Traefik_. It copies the study and the legal documents
   to the VM, deploys Traefik if asked, and starts the survey with
   this repository's reusable deployment workflow. It waits for healthy containers and verified HTTPS.
3. Check `https://<SURVEY_HOST>/`: it shows "Open your personal link" and the footer's legal links.

Review the exercises before the first deployment, which freezes them into the database:
`exgen survey preview <study>` shows them as raters will see them, from the verified files on disk.
Once deployed, the dashboard's **Exercises → Preview** shows the same page for the served files
([preview](../README.md#preview-the-exercises)).

The survey refuses to start when the study is not built for its instrument version, when an
exercise file differs from the frozen manifest, when the database was created for a different plan,
exercises, or instrument wording, or when the imprint or the privacy notice is missing;
`docker compose logs survey` on the VM says which. It does not judge the plan itself: that is
`exgen survey check`, which the data repository's CI runs on every study, so deploy only a commit
whose check passed.

## Activate the main instrument after a pilot

A study that ran a pilot can declare `main_instrument_version` while keeping `instrument_version`
for pilot and test raters. Main and reserve raters, including replacements, use the main instrument.
An optional `main_consent_summary` can give the main cohort its own time estimate. The deployment
allows these two top-level fields to be added once to the existing `study.yaml`. Use double-quoted
single-line values and preserve every other byte of the study directory. The server stops startup
if any main or reserve rater has already answered, drafted, or opened a recorded step, or if the
main instrument or its consent summary changes after activation.

1. On the existing release, make an off-host database backup and export the pilot with its codebook.
   Verify that the main and reserve slots have no progress. Rehearse with the staged study and
   disposable accounts.
2. Deploy the attested release built with the revised instrument. The deployment stops the old
   survey before activating the main questionnaire on the existing database. Keep the database
   volume, rater links, assignments, and exercise files.
3. Verify HTTPS, dashboard timing, and distinct pilot and main export versions. Verify participant
   links by digest. Update the private handoff with the approved invitation wording and estimate.
   Send main invitations only after these checks.
4. If activation fails, check the startup message and whether the new main instrument was frozen.
   Retry the same study and compatible image after resolving the cause. Once main raters have
   started, use a compatible release that serves the same main instrument for any rollback.

## Invite raters

On the VM, in `/opt/exgen-survey`:

```sh
docker compose exec survey survey link --rater R1 --rater R2
docker compose exec survey survey link --admin
```

Send each rater their link through a private channel. A new link revokes the holder's earlier one,
which is also how you replace a lost or leaked link, including the study team's. The mapping from
rater IDs to people stays outside every repository and outside the server.

## While the study runs

- **Follow progress** on the dashboard behind the study team's link: status per rater, readiness
  agreement per exercise, deadlines, new links, and reserve assignments.
- **Back up daily**, and move the copy off the host. `pg_dump` writes a consistent copy while the
  survey runs:

  ```sh
  docker compose exec -T db pg_dump --username=survey --format=custom survey \
    > /secure/backups/survey-$(date +%F).dump
  ```

  Restore into a fresh volume with `pg_restore --username=survey --dbname=survey --clean`.

- **A rater withdraws:** `docker compose exec survey survey withdraw --rater R3` deletes their
  answers and revokes their link; they stay in the plan, so a reserve rater can take over.
- **Security updates** of the server or its base images are a new image of this repository:
  deploy its tag. The database keeps the answers, and a server that changed the instrument's
  wording refuses to start rather than mix answers to two wordings.
- **Do not change** the study directory or the database volume during the study. The database
  records the plan, the exercise digests, and the instrument when it is created. Never run the
  deployment with `deploy-docker-compose`'s `remove-volumes` input: it deletes every answer.
- **Optionally**, the study team's dashboard can be limited to the institution's network with a
  second Traefik router for `/admin` and `/api/admin` that applies an `ipAllowList` middleware. Its
  link is already a revocable secret, so this is extra protection, not a requirement.

## Close the study

```sh
docker compose exec -T survey sh -c 'survey export --output /tmp/export.zip > /dev/null && cat /tmp/export.zip' > export.zip
docker compose down
```

Commit the export to the results repository (see its `studies/README.md`), together with the
exgen-bench image tag and the data repository commit the survey ran. Keep the last backup until the
results are archived and the free-text review is done, then delete the volume with
`docker compose down --volumes` and the backups, as the privacy notice promises.

## Try it locally

`bun run survey:demo` runs the demo study on http://127.0.0.1:4180 with a throwaway database. To run
the deployment's stack itself, build the image, create the network the host's Traefik would, and
fill in a `.env` from [`example.env`](example.env):

```sh
docker build -f tools/tier3-expert-rating/deploy/Dockerfile -t ghcr.io/ls1intum/exgen-bench/survey:local .
docker network create traefik
cd tools/tier3-expert-rating/deploy && cp example.env .env   # IMAGE_TAG=local, STUDY_DIRECTORY=…
docker compose up --detach --wait
docker compose exec survey survey link --admin
```

Without a Traefik in front, reach the survey through `docker compose exec survey wget -qO- …`, or
start a local `traefik:v3.7` on the `traefik` network.

## Upgrade to instrument version 4

Version 4 clarifies automatic assessment and asks for brief feedback only on each rater's assigned
exercises. BR2 now asks about topics and prerequisites, without asking about topic order.

Before deployment, set `instrument_version: "4"` in the study definition and validate it with
`exgen survey check`. The frozen exercise files can stay unchanged: these changes affect the
instrument and the server, not exercise material. Pin the data repository's tooling and deployment
to the reviewed version 4 commit and use the image built from that commit.

Archive the old export, database, study definition and image tag before the transition. Start
version 4 with a fresh database and study copy. Never copy answers, drafts, consent or completion
state between instrument versions, and never delete the old database to make an upgrade succeed.
After deployment, issue test links, complete the assigned exercises and brief feedback, reload the
session, and inspect both the personal answers and the admin export. Brief numbers match each
rater's `position` in `ratings.csv`, rather than a global course order.

## Java4Shell runtime security update

Both the survey build and runtime use the official Eclipse Temurin 25.0.5.1+2 image on
Ubuntu Noble, pinned by its image digest. This release includes the vendor fix for
CVE-2026-114938. The survey image no longer sets the temporary
`-XX:-UseBASE64Intrinsics` workaround. The first emergency deployment used Oracle's
patched 25.0.5.1+4 build with that flag as an additional safeguard.

Before deploying a runtime change, preserve an off-host backup. Verify the running JVM
with `docker compose exec survey jcmd 1 VM.version`, check readiness and the legal and
admin APIs, and confirm that existing links and records are intact. Use a vendor-patched
image for any rollback.

Vendor references:

- https://adoptium.net/news/2026/11/temurin-november-2026-cspu-java4shell
- https://www.oracle.com/security-alerts/cspunov2026.html
