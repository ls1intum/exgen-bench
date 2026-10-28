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


def compose(directory, *args):
    subprocess.run(
        ["docker", "--config", "/opt/exgen-survey/.docker", "compose", *args],
        cwd=directory,
        check=True,
    )


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
    source = args.data.resolve() / "studies" / study_id
    if not (source / "study.yaml").is_file() or not (source / "exercises/manifest.json").is_file():
        raise ValueError("the study must be built and checked in data CI")
    digest = tree_digest(source)
    survey = Path("/opt/exgen-survey")
    traefik = Path("/opt/traefik")
    tooling = Path(__file__).resolve().parent
    deployed = survey / "study"
    # Frozen material may not change under an existing database. A new study needs a fresh deployment.
    if deployed.exists() and tree_digest(deployed) != digest:
        raise ValueError("the deployed study differs; use a fresh deployment/database for another study")
    survey.mkdir(mode=0o750, exist_ok=True)
    (survey / ".docker").mkdir(mode=0o700, exist_ok=True)
    if not deployed.exists():
        shutil.copytree(source, deployed)
    shutil.copytree(args.data.resolve() / "deploy/legal", survey / "legal", dirs_exist_ok=True)
    replace_file(survey / "compose.yaml", (tooling / "compose.yaml").read_bytes())
    text = "".join(f"{key}={json.dumps(value)}\n" for key, value in configuration.items())
    replace_file(survey / ".env", text.encode(), 0o640)
    if os.environ.get("DEPLOY_TRAEFIK") == "true":
        email = required("ACME_EMAIL")
        traefik.mkdir(mode=0o750, exist_ok=True)
        replace_file(traefik / "compose.yaml", (tooling / "traefik.yaml").read_bytes())
        replace_file(traefik / ".env", f"ACME_EMAIL={json.dumps(email)}\n".encode(), 0o600)
        acme = traefik / "acme.json"
        acme.touch(mode=0o600, exist_ok=True)
        acme.chmod(0o600)
        compose(traefik, "up", "--detach", "--wait", "--wait-timeout", "120")
    compose(survey, "pull")
    compose(survey, "up", "--detach", "--wait", "--wait-timeout", "180")
    for attempt in range(19):
        try:
            with urllib.request.urlopen(f"https://{host}/api/site", timeout=20) as response:
                site = json.load(response)
            if not {"imprint", "privacy"}.issubset({link["id"] for link in site["legal"]}):
                raise ValueError("the public site must provide imprint and privacy links")
            break
        except (urllib.error.URLError, TimeoutError):
            if attempt == 18:
                raise
            time.sleep(5)
    provenance = {"study": study_id, "image_tag": image, "data_commit": os.environ.get("GITHUB_SHA"), "study_files": digest}
    replace_file(survey / "deployment.json", (json.dumps(provenance, indent=2) + "\n").encode(), 0o640)
    print(f"Healthy survey with verified HTTPS: https://{host}/ ({study_id}, {image})")


if __name__ == "__main__":
    main()
