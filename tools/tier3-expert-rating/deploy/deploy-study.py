#!/usr/bin/env python3
"""Deploy one frozen study on its VM; never replace the database volume or issue links."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request

SURVEY = Path("/opt/exgen-survey")
TRAEFIK = Path("/opt/traefik")
# A reviewed request, committed to the data repository, to replace the active main instrument.
REQUEST = Path("deploy/main-instrument-activation.json")
REQUEST_KEYS = {"study", "from_version", "to_version", "expected_active_fingerprint", "study_yaml_sha256"}
VERSION_LINE = rb'^main_instrument_version: "([0-9]+)"\n'
CONSENT_LINE = rb'^main_consent_summary: "[^\n]+"\n'
# The server's own test for main or reserve activity (SurveyStore.requireNoMainActivity).
MAIN_ACTIVITY = """SELECT count(*) FROM rater r WHERE r.role IN ('main', 'reserve')
  AND (r.declined_at IS NOT NULL OR r.withdrawn_at IS NOT NULL
    OR EXISTS (SELECT 1 FROM step s WHERE s.rater_id = r.id)
    OR EXISTS (SELECT 1 FROM event e WHERE e.rater_id = r.id))"""
ACTIVE_MAIN = "SELECT value FROM frozen WHERE key = 'main_instrument'"


def required(name):
    value = os.environ.get(name, "")
    if not value or "\n" in value or "\r" in value:
        raise ValueError(f"set a nonempty, single-line {name}")
    return value


def tree_digest(directory):
    files = {}
    for entry in sorted(directory.rglob("*")):
        if entry.is_symlink():
            raise ValueError(f"study may not contain symlinks: {entry.name}")
        if entry.is_file():
            files[str(entry.relative_to(directory))] = hashlib.sha256(entry.read_bytes()).hexdigest()
    return files


def replace_file(target, content, mode=0o644):
    descriptor, temporary = tempfile.mkstemp(dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            os.fchmod(stream.fileno(), mode)
        os.replace(temporary, target)
    finally:
        Path(temporary).unlink(missing_ok=True)


def docker(directory, *args, **options):
    """`docker compose` in a deployment directory; the one place this script runs Docker."""
    return subprocess.run(
        ["docker", "--config", str(SURVEY / ".docker"), "compose", *args],
        cwd=directory,
        check=True,
        **options,
    )


def compose(directory, *args):
    docker(directory, *args)


def sql(query):
    """One value from the survey's database, read in its container."""
    result = docker(
        SURVEY,
        "exec", "-T", "db", "psql", "--username=survey", "--dbname=survey", "--no-psqlrc",
        "--tuples-only", "--no-align", "--set=ON_ERROR_STOP=1", f"--command={query}",
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def verify_https(host):
    for attempt in range(19):
        try:
            with urllib.request.urlopen(f"https://{host}/api/site", timeout=20) as response:
                site = json.load(response)
            if not {"imprint", "privacy"}.issubset({link["id"] for link in site["legal"]}):
                raise ValueError("the public site must provide imprint and privacy links")
            return
        except (urllib.error.URLError, TimeoutError):
            if attempt == 18:
                raise
            time.sleep(5)


def main_instrument_activation(deployed, source, old_digest, new_digest):
    """Accept one additive questionnaire configuration change, with every other byte frozen."""
    key = "study.yaml"
    if ({name: value for name, value in old_digest.items() if name != key}
            != {name: value for name, value in new_digest.items() if name != key}):
        return False
    old = (deployed / key).read_bytes()
    new = (source / key).read_bytes()
    version = rb'^main_instrument_version: "[0-9]+"\n'
    consent = rb'^main_consent_summary: "[^\n]+"\n'
    if re.search(rb"^main_(instrument_version|consent_summary):", old, flags=re.M):
        return False
    remainder, versions = re.subn(version, b"", new, flags=re.M)
    remainder, summaries = re.subn(consent, b"", remainder, flags=re.M)
    return versions == 1 and summaries <= 1 and remainder == old


def load_request(data, study_id):
    """The data repository's request to replace the active main instrument, or None."""
    path = data / REQUEST
    if not path.exists():
        return None
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"{REQUEST} must be a regular file")
    request = json.loads(path.read_bytes())
    if not isinstance(request, dict) or set(request) != REQUEST_KEYS:
        raise ValueError(f"{REQUEST} must hold exactly {', '.join(sorted(REQUEST_KEYS))}")
    if not all(isinstance(value, str) for value in request.values()):
        raise ValueError(f"every value in {REQUEST} is a string")
    if request["study"] != study_id:
        raise ValueError(f"{REQUEST} is for study {request['study']}, not {study_id}; remove it")
    for name in ("from_version", "to_version"):
        if not re.fullmatch(r"[0-9]+", request[name]):
            raise ValueError(f"{name} in {REQUEST} must be an instrument version such as 7")
    if request["from_version"] == request["to_version"]:
        raise ValueError(f"{REQUEST} replaces version {request['from_version']} by itself")
    for name in ("expected_active_fingerprint", "study_yaml_sha256"):
        if not re.fullmatch(r"[0-9a-f]{64}", request[name]):
            raise ValueError(f"{name} in {REQUEST} must be 64 lowercase hexadecimal characters")
    return request


def contract(text):
    """study.yaml's main instrument versions and consent summaries, and everything else."""
    versions = re.findall(VERSION_LINE, text, flags=re.M)
    remainder = re.sub(VERSION_LINE, b"", text, flags=re.M)
    summaries = len(re.findall(CONSENT_LINE, remainder, flags=re.M))
    remainder = re.sub(CONSENT_LINE, b"", remainder, flags=re.M)
    return [version.decode() for version in versions], summaries, remainder


def main_instrument_replacement(deployed, source, old_digest, new_digest, request):
    """Check that the study changes only its main instrument, as the request says; raise otherwise."""
    key = "study.yaml"
    changed = sorted(name for name in old_digest.keys() | new_digest.keys()
                     if name != key and old_digest.get(name) != new_digest.get(name))
    if changed:
        raise ValueError("replacing the main instrument may change only study.yaml, not "
                         + ", ".join(changed[:5]))
    old = (deployed / key).read_bytes()
    new = (source / key).read_bytes()
    if hashlib.sha256(new).hexdigest() != request["study_yaml_sha256"]:
        raise ValueError(f"study.yaml is not the file {REQUEST} approved (study_yaml_sha256)")
    old_versions, old_summaries, old_rest = contract(old)
    new_versions, new_summaries, new_rest = contract(new)
    if old_versions != [request["from_version"]]:
        raise ValueError(f"the deployed study.yaml names main instrument {', '.join(old_versions) or 'none'}, "
                         f"not {request['from_version']}")
    if new_versions != [request["to_version"]]:
        raise ValueError(f"the new study.yaml must name main instrument {request['to_version']} once, "
                         f"as a double-quoted line, not {', '.join(new_versions) or 'none'}")
    if old_summaries > 1 or new_summaries > 1:
        raise ValueError("study.yaml may hold one double-quoted main_consent_summary line")
    if old_rest != new_rest:
        raise ValueError("study.yaml changes more than main_instrument_version and main_consent_summary")


def activation_environment(request):
    if request is None:
        return {}
    return {
        "SURVEY_ACTIVATION_FROM": request["expected_active_fingerprint"],
        "SURVEY_ACTIVATION_TO": request["to_version"],
    }


def write_environment(configuration, request=None):
    values = {**configuration, **activation_environment(request)}
    text = "".join(f"{key}={json.dumps(value)}\n" for key, value in values.items())
    replace_file(SURVEY / ".env", text.encode(), 0o640)


def preflight(request):
    """Refuse before anything changes when the database is not the state the request expects."""
    active = sql(ACTIVE_MAIN)
    if active != request["expected_active_fingerprint"]:
        raise ValueError(f"the database's active main instrument is {active or 'none'}, not the expected "
                         f"{request['expected_active_fingerprint']}; nothing was changed")
    started = sql(MAIN_ACTIVITY)
    if started != "0":
        raise ValueError(f"{started} main or reserve raters have already started; "
                         "their instrument cannot change; nothing was changed")


def backup(journal):
    """A verified custom-format dump of the database before the activation, kept on the host."""
    target = journal / "before.dump"
    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "wb") as stream:
        docker(SURVEY, "exec", "-T", "db", "pg_dump", "--username=survey", "--format=custom", "survey",
               stdout=stream)
    if target.stat().st_size == 0:
        raise ValueError("the database backup is empty; nothing was changed")
    with open(target, "rb") as stream:
        docker(SURVEY, "exec", "-T", "db", "pg_restore", "--list", stdin=stream, stdout=subprocess.DEVNULL)
    return target


def record(journal, status, **details):
    state = json.loads((journal / "state.json").read_text()) if (journal / "state.json").exists() else {}
    state.update(details, status=status, updated=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    replace_file(journal / "state.json", (json.dumps(state, indent=2) + "\n").encode(), 0o600)


def replaced(request):
    """Whether the server replaced exactly the expected main instrument and logged it."""
    if sql(ACTIVE_MAIN) in ("", request["expected_active_fingerprint"]):
        return False
    audit = sql("SELECT count(*) FROM change_log WHERE action = 'main instrument replaced' "
                f"AND detail LIKE '%with fingerprint {request['expected_active_fingerprint']};%'")
    return audit != "0"


def activate(request, configuration, deployed, source, journal, resume):
    """Stop the survey, switch study.yaml, and start the new release with the exact authorization."""
    previous = json.loads((SURVEY / "deployment.json").read_text()) if (SURVEY / "deployment.json").exists() else {}
    before = (deployed / "study.yaml").read_bytes()
    if not resume:
        replace_file(journal / "study.yaml.before", before, 0o600)
    staged = (source / "study.yaml").read_bytes()
    replace_file(journal / "study.yaml.next", staged, 0o600)
    if hashlib.sha256(staged).hexdigest() != request["study_yaml_sha256"]:
        raise ValueError("the staged study.yaml differs from the approved one; nothing was changed")
    record(journal, "staged", request=request, previous_image_tag=previous.get("image_tag"),
           image_tag=configuration["IMAGE_TAG"], resume=resume)
    compose(SURVEY, "pull")
    write_environment(configuration, request)
    # The old server must stop before the new one checks and replaces the main cohort's instrument.
    compose(SURVEY, "stop", "survey")
    record(journal, "stopped")
    replace_file(deployed / "study.yaml", staged)
    record(journal, "switched")
    try:
        compose(SURVEY, "up", "--detach", "--wait", "--wait-timeout", "180")
        if not replaced(request):
            raise ValueError("the server started without recording the replacement")
    except (subprocess.CalledProcessError, ValueError) as failure:
        recover(request, configuration, deployed, journal, previous, resume, failure)
    record(journal, "replaced")
    # Restart without the authorization: the activated database must serve on its own.
    write_environment(configuration)
    try:
        compose(SURVEY, "up", "--detach", "--wait", "--wait-timeout", "180")
    except subprocess.CalledProcessError as failure:
        record(journal, "replaced, restart failed", error=str(failure))
        raise RuntimeError("the main instrument was replaced, but the survey did not restart without the "
                           "authorization; fix forward, never start the previous release. "
                           f"Journal and backup: {journal}") from failure
    record(journal, "complete")


def recover(request, configuration, deployed, journal, previous, resume, failure):
    """Return to the previous release if nothing was replaced; otherwise never serve the old instrument."""
    write_environment(configuration)
    try:
        active = sql(ACTIVE_MAIN)
    except subprocess.CalledProcessError:
        active = None
    if active == request["expected_active_fingerprint"] and not resume and previous.get("image_tag"):
        replace_file(deployed / "study.yaml", (journal / "study.yaml.before").read_bytes())
        write_environment({**configuration, "IMAGE_TAG": previous["image_tag"]})
        record(journal, "rolled back", error=str(failure))
        try:
            compose(SURVEY, "up", "--detach", "--wait", "--wait-timeout", "180")
        except subprocess.CalledProcessError:
            raise RuntimeError(f"activation refused ({failure}) and the previous release "
                               f"{previous['image_tag']} did not start; see docker compose logs survey") from failure
        raise RuntimeError(f"activation refused ({failure}); nothing was replaced and the previous release "
                           f"{previous['image_tag']} serves again; see docker compose logs survey") from failure
    if active == request["expected_active_fingerprint"]:
        record(journal, "refused", error=str(failure))
        compose(SURVEY, "stop", "survey")
        raise RuntimeError(f"activation refused ({failure}); nothing was replaced, and the survey stays "
                           f"stopped; see docker compose logs survey and {journal}") from failure
    record(journal, "failed after replacement" if active else "unknown", error=str(failure))
    raise RuntimeError(f"the new release is not healthy ({failure}); the database's main instrument is "
                       f"{active or 'unknown'}. Do not start the previous release; fix forward with the "
                       f"same study and a compatible image. Journal and backup: {journal}") from failure


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    args = parser.parse_args()
    study_id = required("STUDY")
    image = required("IMAGE_TAG")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{1,63}", study_id):
        raise ValueError("invalid study ID")
    if not re.fullmatch(r"sha-[0-9a-f]{7,40}", image):
        raise ValueError("pin the image with sha-<commit>")
    host = required("SURVEY_HOST")
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", host):
        raise ValueError("invalid SURVEY_HOST")
    configuration = {
        "IMAGE_TAG": image,
        "SURVEY_HOST": host,
        "POSTGRES_PASSWORD": required("POSTGRES_PASSWORD"),
        "SURVEY_LEGAL_IMPRINT": required("SURVEY_LEGAL_IMPRINT"),
        "SURVEY_LEGAL_PRIVACY": required("SURVEY_LEGAL_PRIVACY"),
        "SURVEY_LEGAL_ACCESSIBILITY": os.environ.get("SURVEY_LEGAL_ACCESSIBILITY", ""),
    }
    data = args.data.resolve()
    source = data / "studies" / study_id
    if not (source / "study.yaml").is_file() or not (source / "exercises/manifest.json").is_file():
        raise ValueError("the study must be built and checked in data CI")
    digest = tree_digest(source)
    request = load_request(data, study_id)
    tooling = Path(__file__).resolve().parent
    deployed = SURVEY / "study"
    activate_main = False
    replace_main = None
    if deployed.exists():
        existing_digest = tree_digest(deployed)
        if existing_digest != digest:
            activate_main = main_instrument_activation(deployed, source, existing_digest, digest)
            if activate_main and request is not None:
                raise ValueError(f"{REQUEST} replaces an active main instrument, but this deployment "
                                 "activates the first one; remove the request")
            if not activate_main and request is None:
                raise ValueError("the deployed study differs; use a fresh deployment/database for another study")
            if not activate_main:
                main_instrument_replacement(deployed, source, existing_digest, digest, request)
                replace_main = "replace"
        elif request is not None:
            # Already switched on disk: either activated, or an interrupted run to resume.
            if sql(ACTIVE_MAIN) == request["expected_active_fingerprint"]:
                if contract((deployed / "study.yaml").read_bytes())[0] != [request["to_version"]]:
                    raise ValueError(f"the deployed study.yaml does not name main instrument {request['to_version']}")
                replace_main = "resume"
            else:
                print(f"{REQUEST}: the database no longer holds the expected main instrument; "
                      "the request was applied before and is ignored. Remove it from the data repository.")
    elif request is not None:
        raise ValueError(f"{REQUEST} applies to a running deployment only; remove it for a fresh deployment")
    journal = None
    if replace_main:
        # Every check before any change: the expected database, no main activity, a verified backup.
        preflight(request)
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        (SURVEY / "activations").mkdir(mode=0o700, exist_ok=True)
        journal = SURVEY / "activations" / f"{stamp}-main-{request['from_version']}-to-{request['to_version']}"
        journal.mkdir(mode=0o700)
        replace_file(journal / "request.json", (json.dumps(request, indent=2) + "\n").encode(), 0o600)
        print(f"Backed up the database to {backup(journal)}")
    SURVEY.mkdir(mode=0o750, exist_ok=True)
    (SURVEY / ".docker").mkdir(mode=0o700, exist_ok=True)
    if not deployed.exists():
        shutil.copytree(source, deployed)
    shutil.copytree(data / "deploy/legal", SURVEY / "legal", dirs_exist_ok=True)
    replace_file(SURVEY / "compose.yaml", (tooling / "compose.yaml").read_bytes())
    write_environment(configuration)
    if os.environ.get("DEPLOY_TRAEFIK") == "true":
        email = required("ACME_EMAIL")
        TRAEFIK.mkdir(mode=0o750, exist_ok=True)
        replace_file(TRAEFIK / "compose.yaml", (tooling / "traefik.yaml").read_bytes())
        replace_file(TRAEFIK / ".env", f"ACME_EMAIL={json.dumps(email)}\n".encode(), 0o600)
        acme = TRAEFIK / "acme.json"
        acme.touch(mode=0o600, exist_ok=True)
        acme.chmod(0o600)
        compose(TRAEFIK, "up", "--detach", "--wait", "--wait-timeout", "120")
    if replace_main:
        activate(request, configuration, deployed, source, journal, replace_main == "resume")
    else:
        compose(SURVEY, "pull")
        if activate_main:
            # The old server must stop before checking and freezing the main cohort's instrument.
            compose(SURVEY, "stop", "survey")
            replace_file(deployed / "study.yaml", (source / "study.yaml").read_bytes())
        compose(SURVEY, "up", "--detach", "--wait", "--wait-timeout", "180")
    verify_https(host)
    provenance = {"study": study_id, "image_tag": image, "data_commit": os.environ.get("GITHUB_SHA"), "study_files": digest}
    if replace_main:
        provenance["main_instrument_replacement"] = {**request, "journal": str(journal)}
    replace_file(SURVEY / "deployment.json", (json.dumps(provenance, indent=2) + "\n").encode(), 0o640)
    print(f"Healthy survey with verified HTTPS: https://{host}/ ({study_id}, {image})")


if __name__ == "__main__":
    main()
