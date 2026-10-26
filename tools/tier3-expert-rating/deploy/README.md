# Running the survey for a study

This runbook takes a built study from the data repository to a public HTTPS survey, keeps its
answers safe while it runs, and ends with an export for the results repository. The server runs in
a container behind [Caddy](https://caddyserver.com/docs/automatic-https), which obtains and renews
the TLS certificate.

## What you need

- A Linux host with Docker Engine and the Compose plugin, reachable on ports 80 and 443.
- A DNS name for the survey that points to the host.
- Read access to exgen-bench and to the data repository on the host.
- A study in the data repository whose exercises are built and checked (`exgen survey check` reports
  "The study is ready."), committed at a commit you record. Building needs the run directories
  and the Java toolchain; serving does not.

## Start

```sh
git clone https://github.com/ls1intum/exgen-bench.git /srv/exgen-bench
git -C /srv/exgen-bench checkout <exgen-bench commit the study was checked with>
git clone <data repository> /srv/exgen-bench-data
git -C /srv/exgen-bench-data checkout <frozen study commit>

cd /srv/exgen-bench/tools/tier3-expert-rating/deploy
cp example.env survey.env        # set SURVEY_DOMAIN and STUDY_DIRECTORY
docker compose --env-file survey.env up -d --build
curl https://<SURVEY_DOMAIN>/healthz     # prints ok
```

The survey container runs as an unprivileged user on a read-only file system and is reachable only
through Caddy. It refuses to start when the study fails its check, when an exercise file differs
from the frozen manifest, or when the database was created for a different plan, exercises, or
instrument wording. Its answers live in the `survey-data` volume.

## Invite raters

```sh
alias survey='docker compose --env-file survey.env exec survey exgen survey'
survey link /study --db /data/survey.sqlite --url https://<SURVEY_DOMAIN> --rater R1 --rater R2
survey link /study --db /data/survey.sqlite --url https://<SURVEY_DOMAIN> --admin
```

Send each rater their link through a private channel. A new link revokes the holder's earlier one,
which is also how you replace a lost or leaked link, including the study team's. The mapping from
rater IDs to people stays outside every repository and outside the server.

## While the study runs

- **Follow progress** on the dashboard behind the study team's link: status per rater, readiness
  agreement per exercise, deadlines, new links, and reserve assignments.
- **Back up daily** with a consistent copy, then move it off the host:

  ```sh
  survey backup /study --db /data/survey.sqlite --output /data/backup-$(date +%F).sqlite
  docker compose --env-file survey.env cp survey:/data/backup-$(date +%F).sqlite /secure/backups/
  ```

  Copying `survey.sqlite` itself is not a backup while the server runs, because SQLite keeps recent
  writes in a separate WAL file.

- **A rater withdraws:** `survey withdraw /study --db /data/survey.sqlite --rater R3` deletes their
  answers and revokes their link; they stay in the plan, so a reserve rater can take over.
- **Do not change** the exgen-bench commit, the study directory, or the volume during the study.
  The database records the plan, the exercise digests, and the instrument when it is created, and
  the server refuses to start on any change to them.

## Close the study

```sh
survey export /study --db /data/survey.sqlite --output /data/export.zip
docker compose --env-file survey.env cp survey:/data/export.zip .
docker compose --env-file survey.env down
```

Commit the export to the results repository (see its `studies/README.md`), together with the
exgen-bench and data repository commits the survey ran. Keep the last backup until the results are
archived and the free-text review is done, then delete the volumes with `docker compose down -v`.

## Try it locally

The same stack runs on a workstation with the demo study, a self-signed certificate, and spare
ports:

```sh
bun run survey:demo                      # builds the demo study, then stop it with Ctrl+C
printf 'SURVEY_DOMAIN=localhost\nSTUDY_DIRECTORY=%s\nHTTP_PORT=8080\nHTTPS_PORT=8443\n' \
  "$PWD/tools/tier3-expert-rating/demo" > /tmp/survey.env
cd tools/tier3-expert-rating/deploy && docker compose --env-file /tmp/survey.env up -d --build
```
