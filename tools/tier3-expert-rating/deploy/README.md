# Running the survey for a study

This runbook takes a built study from the data repository to a public HTTPS survey, keeps its
answers safe while it runs, and ends with an export for the results repository. The survey and its
PostgreSQL run with Docker Compose ([`compose.yaml`](compose.yaml)) behind the host's shared
Traefik, which obtains the TLS certificate. GitHub Actions deploy all three, with the reusable
workflows of [`ls1intum/.github`](https://github.com/ls1intum/.github).

```text
exgen-bench (this repository)                 data repository (the study)
  main ──Survey image──► ghcr.io/…/survey:sha-<commit>
                                     │        studies/<study>/  deploy/  ──Deploy survey──► VM
                                     └────────────────────────────────────────────────────►  /opt/exgen-survey
                                                                                              ├─ compose.yaml, .env
                                                                                              ├─ study/  (read-only)
                                                                                              └─ legal/  (read-only)
```

## What you need

- A VM with Docker Engine and the Compose plugin, reachable on ports 80 and 443, and a DNS name for
  the survey that points to it.
- **Approval for public access.** A survey that experts outside the institution's network reach is
  exposed to the Internet; the institution's IT may require a review of this deployment first. This
  runbook, [`compose.yaml`](compose.yaml) and the server's [security notes](../README.md#security)
  are what such a review reads.
- The TLS secrets of the Traefik certificate resolver (`HARICA_ACME_CA_SERVER`,
  `HARICA_ACME_EAB_KID`, `HARICA_ACME_EAB_HMAC`), which the IT sets in the data repository.
- An imprint and a privacy notice for the deployment: a URL each, or Markdown files in the data
  repository's `deploy/legal/`. [`legal/`](legal/) holds templates; the privacy notice must name
  the study's legal basis, retention and contacts, so check it with the data protection officer.
- A study whose exercises are built and checked (`exgen survey check` reports "The study is
  ready."), committed to the data repository, and an image of this repository at a commit whose
  instrument version the study names.

## Set up the deployment

In the data repository, create a GitHub environment (for example `Survey`) with:

| Kind     | Name                                                                   | Value                                                 |
| -------- | ---------------------------------------------------------------------- | ----------------------------------------------------- |
| variable | `VM_HOST`, `VM_USERNAME`                                               | the VM and the user the workflow logs in as           |
| secret   | `VM_SSH_PRIVATE_KEY`                                                   | that user's key                                       |
| variable | `SURVEY_HOST`                                                          | the survey's DNS name, such as `survey.example.org`   |
| secret   | `POSTGRES_PASSWORD`                                                    | a random password, for example `openssl rand -hex 32` |
| variable | `SURVEY_LEGAL_IMPRINT`, `SURVEY_LEGAL_PRIVACY`                         | a URL, or `/legal/<file>.md` from `deploy/legal/`     |
| variable | `SURVEY_LEGAL_ACCESSIBILITY`                                           | optional, as above                                    |
| secret   | `HARICA_ACME_CA_SERVER`, `HARICA_ACME_EAB_KID`, `HARICA_ACME_EAB_HMAC` | set by the IT, for Traefik                            |

The organisation provides the jump host (`DEPLOYMENT_GATEWAY_*`). The deployment workflow writes
every variable and secret of the environment to `/opt/exgen-survey/.env` on the VM, so keep the
environment to these. The VM user needs write access to `/opt/traefik` and `/opt/exgen-survey`.

## Deploy

1. Wait for the **Survey image** workflow of this repository to build the commit you want; its
   image is `ghcr.io/ls1intum/exgen-bench/survey:sha-<7-character commit>`. The workflow runs for
   every change on `main` and on demand for another branch.
2. In the data repository, run the **Deploy survey** workflow with the study directory, the image
   tag, and, on the first deployment, _Deploy Traefik_. It copies the study and the legal documents
   to the VM, deploys Traefik if asked, and starts the survey with
   `ls1intum/.github`'s `deploy-docker-compose` workflow.
3. Check `https://<SURVEY_HOST>/`: it shows "Open your personal link" and the footer's legal links.

The survey refuses to start when the study fails its checks, when an exercise file differs from the
frozen manifest, when the database was created for a different plan, exercises, or instrument
wording, or when the imprint or the privacy notice is missing. `docker compose logs survey` on the
VM says which.

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
  records the plan, the exercise digests, and the instrument when it is created.

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
