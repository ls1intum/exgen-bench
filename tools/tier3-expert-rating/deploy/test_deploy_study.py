"""Tests of deploy-study.py's main instrument activation, against a simulated host.

Run with `python3 -m unittest discover -s tools/tier3-expert-rating/deploy -p 'test_*.py'`. The fake
host mirrors what the server does at startup (SurveyStore.synchronize): it serves a study only when
its main instrument matches the database, or when SURVEY_ACTIVATION_* authorizes exactly the
replacement and no main or reserve rater started.
"""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("deploy_study", Path(__file__).with_name("deploy-study.py"))
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

STUDY = "expert-study-5"
FINGERPRINT = {"6": "6" * 64, "7": "7" * 64}
OLD_IMAGE, NEW_IMAGE = "sha-0000001", "sha-0000002"
# Which main instruments an image can serve.
SERVES = {OLD_IMAGE: {"6"}, NEW_IMAGE: {"6", "7"}}


def study_yaml(main=None, summary=None, details=None):
    text = 'schema_version: "1"\nid: expert-study-5\ninstrument_version: "5"\n'
    if main:
        text += f'main_instrument_version: "{main}"\n'
    if summary:
        text += f'main_consent_summary: "{summary}"\n'
    if details:
        text += f'main_consent_details: {json.dumps(details)}\n'
    return (text + "raters:\n  - { id: R1, role: main, exercises: [E1] }\n").encode()


def request_for(new_study_yaml, **changes):
    return {
        "study": STUDY,
        "from_version": "6",
        "to_version": "7",
        "expected_active_fingerprint": FINGERPRINT["6"],
        "study_yaml_sha256": hashlib.sha256(new_study_yaml).hexdigest(),
        **changes,
    }


class Host:
    """The VM: the survey directory, its database, and Docker Compose."""

    def __init__(self, root, active="6", started=0):
        self.root = root
        self.active = FINGERPRINT[active] if active else ""
        self.started = started
        self.audit = []
        self.calls = []
        self.running = None
        self.fail_after_replacement = False
        self.start_after_stop = 0

    def environment(self):
        values = {}
        for line in (self.root / ".env").read_text().splitlines():
            key, value = line.split("=", 1)
            values[key] = json.loads(value)
        return values

    def version(self):
        return deploy.contract((self.root / "study" / "study.yaml").read_bytes())[0][0]

    def start(self):
        """SurveyStore.synchronize, simplified to what the deployment relies on."""
        environment = self.environment()
        version = self.version()
        if version not in SERVES[environment["IMAGE_TAG"]]:
            raise ValueError("unknown instrument")
        loaded = FINGERPRINT[version]
        expected, target = environment.get("SURVEY_ACTIVATION_FROM"), environment.get("SURVEY_ACTIVATION_TO")
        if expected and target != version:
            raise ValueError("study.yaml names another main instrument")
        if not self.active and not expected:
            if self.started:
                raise ValueError("main or reserve raters have already started")
            self.active = loaded
        if loaded != self.active:
            if not expected:
                raise ValueError("the frozen main instrument changed")
            if expected != self.active:
                raise ValueError("not the expected")
            if self.started:
                raise ValueError("main or reserve raters have already started")
            self.audit.append(f"with fingerprint {self.active}; none of them had started")
            self.active = loaded
        self.running = (environment["IMAGE_TAG"], version)

    def docker(self, directory, *args, **options):
        self.calls.append(args)
        if args[:3] == ("exec", "-T", "db"):
            command = args[3]
            if command == "psql":
                query = args[-1].removeprefix("--command=")
                if query == deploy.ACTIVE_MAIN:
                    output = self.active
                elif query == deploy.MAIN_ACTIVITY:
                    output = str(self.started)
                else:
                    pattern = query.split("LIKE '%")[1].split("%'")[0]
                    output = str(sum(pattern in entry for entry in self.audit))
                return subprocess.CompletedProcess(args, 0, stdout=output + "\n")
            if command == "pg_dump":
                options["stdout"].write(b"PGDMP")
            return subprocess.CompletedProcess(args, 0)
        if args == ("stop", "survey"):
            self.running = None
            self.started += self.start_after_stop
        elif args[0] == "up" and directory == self.root:
            try:
                self.start()
            except ValueError as refusal:
                raise subprocess.CalledProcessError(1, args, stderr=str(refusal))
            if self.fail_after_replacement and self.active == FINGERPRINT["7"]:
                raise subprocess.CalledProcessError(1, args, stderr="unhealthy")
        return subprocess.CompletedProcess(args, 0)


class DeploymentTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.base = Path(directory.name)
        self.survey = self.base / "opt/exgen-survey"
        self.data = self.base / "data"
        self.source = self.data / "studies" / STUDY
        (self.source / "exercises").mkdir(parents=True)
        (self.source / "exercises/manifest.json").write_text('{"exercises": []}\n')
        (self.data / "deploy/legal").mkdir(parents=True)
        (self.data / "deploy/legal/privacy.md").write_text("Privacy\n")
        self.host = Host(self.survey)
        for name, value in {"SURVEY": self.survey, "TRAEFIK": self.base / "opt/traefik"}.items():
            patcher = mock.patch.object(deploy, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        for name, value in {"docker": self.host.docker, "verify_https": lambda host: None}.items():
            patcher = mock.patch.object(deploy, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        environment = mock.patch.dict(os.environ, {
            "STUDY": STUDY,
            "IMAGE_TAG": NEW_IMAGE,
            "SURVEY_HOST": "survey.example.org",
            "POSTGRES_PASSWORD": "secret",
            "SURVEY_LEGAL_IMPRINT": "https://example.org/imprint",
            "SURVEY_LEGAL_PRIVACY": "/legal/privacy.md",
        })
        environment.start()
        self.addCleanup(environment.stop)

    def deployed(self, content, image=OLD_IMAGE, extra=None):
        """A running deployment of the study with this study.yaml."""
        (self.survey / "study/exercises").mkdir(parents=True)
        (self.survey / "study/study.yaml").write_bytes(content)
        (self.survey / "study/exercises/manifest.json").write_text('{"exercises": []}\n')
        for name, text in (extra or {}).items():
            (self.survey / "study" / name).write_text(text)
        (self.survey / ".env").write_text(f'IMAGE_TAG="{image}"\n')
        (self.survey / "deployment.json").write_text(json.dumps({"image_tag": image}))
        self.host.running = (image, deploy.contract(content)[0][0] if b"main_instrument" in content else None)

    def source_study(self, content, request=None):
        (self.source / "study.yaml").write_bytes(content)
        if request is not None:
            (self.data / deploy.REQUEST).write_text(json.dumps(request))

    def run_deploy(self):
        with mock.patch.object(sys, "argv", ["deploy-study.py", "--data", str(self.data)]):
            deploy.main()

    def journal(self):
        journals = list((self.survey / "activations").iterdir())
        self.assertEqual(len(journals), 1)
        return journals[0]

    def mutations(self):
        return [call for call in self.host.calls if call[0] in ("pull", "stop", "up")]

    # The replacement

    def test_replaces_six_by_seven_with_a_backup_journal_and_audit(self):
        self.deployed(study_yaml("6", "About 90 minutes."))
        new = study_yaml("7", "About 85 minutes.")
        self.source_study(new, request_for(new))
        self.run_deploy()

        self.assertEqual(self.host.active, FINGERPRINT["7"])
        self.assertEqual(self.host.running, (NEW_IMAGE, "7"))
        self.assertEqual(len(self.host.audit), 1)
        self.assertEqual((self.survey / "study/study.yaml").read_bytes(), new)
        # The authorization is gone once the activated database serves on its own.
        self.assertNotIn("SURVEY_ACTIVATION_FROM", self.host.environment())
        self.assertEqual(self.mutations(), [
            ("pull",), ("stop", "survey"),
            ("up", "--detach", "--wait", "--wait-timeout", "180"),
            ("up", "--detach", "--wait", "--wait-timeout", "180"),
        ])
        journal = self.journal()
        self.assertEqual(json.loads((journal / "state.json").read_text())["status"], "complete")
        self.assertEqual((journal / "before.dump").read_bytes(), b"PGDMP")
        self.assertEqual((journal / "before.dump").stat().st_mode & 0o777, 0o600)
        self.assertEqual((journal / "study.yaml.before").read_bytes(), study_yaml("6", "About 90 minutes."))
        # The backup was verified before the survey stopped.
        commands = [call[3] if call[0] == "exec" else call[0] for call in self.host.calls]
        self.assertLess(commands.index("pg_restore"), commands.index("stop"))
        provenance = json.loads((self.survey / "deployment.json").read_text())
        self.assertEqual(provenance["main_instrument_replacement"]["to_version"], "7")

    def test_refuses_an_unexpected_active_fingerprint_before_any_change(self):
        self.deployed(study_yaml("6"))
        new = study_yaml("7")
        self.source_study(new, request_for(new, expected_active_fingerprint="a" * 64))
        with self.assertRaisesRegex(ValueError, "not the expected"):
            self.run_deploy()
        self.assert_untouched(study_yaml("6"))

    def test_refuses_main_or_reserve_activity_before_any_change(self):
        self.host.started = 1
        self.deployed(study_yaml("6"))
        new = study_yaml("7")
        self.source_study(new, request_for(new))
        with self.assertRaisesRegex(ValueError, "already started"):
            self.run_deploy()
        self.assert_untouched(study_yaml("6"))

    def assert_untouched(self, content):
        self.assertEqual(self.mutations(), [])
        self.assertEqual((self.survey / "study/study.yaml").read_bytes(), content)
        self.assertEqual(self.host.environment(), {"IMAGE_TAG": OLD_IMAGE})
        self.assertFalse((self.survey / "activations").exists())
        self.assertEqual(self.host.active, FINGERPRINT["6"])

    def test_a_server_refusal_restores_the_previous_release(self):
        # A main rater starts after the preflight check, before the old server stops.
        self.host.start_after_stop = 1
        self.deployed(study_yaml("6"))
        new = study_yaml("7")
        self.source_study(new, request_for(new))
        with self.assertRaisesRegex(RuntimeError, "nothing was replaced and the previous release"):
            self.run_deploy()
        self.assertEqual(self.host.active, FINGERPRINT["6"])
        self.assertEqual(self.host.running, (OLD_IMAGE, "6"))
        self.assertEqual((self.survey / "study/study.yaml").read_bytes(), study_yaml("6"))
        self.assertEqual(self.host.environment()["IMAGE_TAG"], OLD_IMAGE)
        self.assertNotIn("SURVEY_ACTIVATION_FROM", self.host.environment())
        self.assertEqual(json.loads((self.journal() / "state.json").read_text())["status"], "rolled back")

    def test_never_rolls_back_after_the_database_was_replaced(self):
        self.host.fail_after_replacement = True
        self.deployed(study_yaml("6"))
        new = study_yaml("7")
        self.source_study(new, request_for(new))
        with self.assertRaisesRegex(RuntimeError, "Do not start the previous release"):
            self.run_deploy()
        self.assertEqual(self.host.active, FINGERPRINT["7"])
        self.assertEqual((self.survey / "study/study.yaml").read_bytes(), new)
        self.assertEqual(self.host.environment()["IMAGE_TAG"], NEW_IMAGE)
        self.assertNotIn("SURVEY_ACTIVATION_FROM", self.host.environment())
        # The old release would be refused by the server anyway.
        (self.survey / ".env").write_text(f'IMAGE_TAG="{OLD_IMAGE}"\n')
        (self.survey / "study/study.yaml").write_bytes(study_yaml("6"))
        with self.assertRaisesRegex(ValueError, "frozen main instrument changed"):
            self.host.start()

    def test_resumes_an_interrupted_activation(self):
        # The study already names 7 on disk, but the database still holds 6: the server refuses to start.
        new = study_yaml("7")
        self.deployed(new, image=NEW_IMAGE)
        self.source_study(new, request_for(new))
        self.run_deploy()
        self.assertEqual(self.host.active, FINGERPRINT["7"])
        self.assertEqual(self.host.running, (NEW_IMAGE, "7"))
        self.assertEqual(json.loads((self.journal() / "state.json").read_text())["status"], "complete")

    def test_ignores_an_applied_request(self):
        self.host.active = FINGERPRINT["7"]
        new = study_yaml("7")
        self.deployed(new, image=NEW_IMAGE)
        self.source_study(new, request_for(new))
        self.run_deploy()
        self.assertFalse((self.survey / "activations").exists())
        self.assertNotIn("SURVEY_ACTIVATION_FROM", self.host.environment())
        self.assertEqual(self.host.running, (NEW_IMAGE, "7"))

    def test_an_unrequested_main_instrument_change_is_refused(self):
        self.deployed(study_yaml("6"))
        self.source_study(study_yaml("7"))
        with self.assertRaisesRegex(ValueError, "the deployed study differs"):
            self.run_deploy()
        self.assert_untouched(study_yaml("6"))

    # What the request may change

    def check(self, old, new, request, extra_old=None, extra_new=None):
        self.deployed(old, extra=extra_old)
        self.source_study(new)
        for name, text in (extra_new or {}).items():
            (self.source / name).write_text(text)
        deploy.main_instrument_replacement(
            self.survey / "study", self.source, deploy.tree_digest(self.survey / "study"),
            deploy.tree_digest(self.source), request)

    def test_accepts_only_the_requested_versions_and_consent_overrides(self):
        new = study_yaml("7", "Review three exercises.", 'Full text.\n\nQuote: "Read the prompt."')
        self.check(study_yaml("6", "About 90 minutes."), new, request_for(new))

    def test_refuses_any_other_study_change(self):
        cases = {
            "only study.yaml": (study_yaml("6"), study_yaml("7"), {"exercises/A.json": "1"}, {"exercises/A.json": "2"}),
            "changes more than": (study_yaml("6"), study_yaml("7").replace(b'"5"', b'"4"'), None, None),
            "names main instrument 5, not 6": (study_yaml("5"), study_yaml("7"), None, None),
            "must name main instrument 7 once": (study_yaml("6"), study_yaml("8"), None, None),
            "once": (study_yaml("6"), study_yaml("7") + b'main_instrument_version: "7"\n', None, None),
            "one double-quoted": (study_yaml("6"), study_yaml("7", "a") + b'main_consent_summary: "b"\n', None, None),
            "changes more than main_instrument_version": (
                study_yaml("6"), study_yaml("7") + b'main_consent_details: |\n  New details.\n', None, None),
        }
        for message, (old, new, extra_old, extra_new) in cases.items():
            with self.subTest(message), tempfile.TemporaryDirectory() as root:
                with mock.patch.object(deploy, "SURVEY", Path(root) / "survey"), \
                        mock.patch.object(self, "survey", Path(root) / "survey"), \
                        mock.patch.object(self, "source", Path(root) / "source"):
                    (self.source / "exercises").mkdir(parents=True)
                    (self.source / "exercises/manifest.json").write_text('{"exercises": []}\n')
                    with self.assertRaisesRegex(ValueError, message):
                        self.check(old, new, request_for(new), extra_old, extra_new)

    def test_refuses_a_study_yaml_other_than_the_approved_one(self):
        new = study_yaml("7")
        with self.assertRaisesRegex(ValueError, "approved"):
            self.check(study_yaml("6"), new, request_for(study_yaml("7", "Other")))

    def test_validates_the_request(self):
        new = study_yaml("7")
        cases = {
            "must hold exactly": {**request_for(new), "force": "true"},
            "for study other": request_for(new, study="other"),
            "64 lowercase": request_for(new, expected_active_fingerprint="A" * 64),
            "by itself": request_for(new, to_version="6"),
            "instrument version": request_for(new, to_version="v7"),
        }
        for message, request in cases.items():
            with self.subTest(message):
                (self.data / deploy.REQUEST).write_text(json.dumps(request))
                with self.assertRaisesRegex(ValueError, message):
                    deploy.load_request(self.data, STUDY)

    # The first activation, as before

    def test_the_first_activation_is_unchanged(self):
        self.host.active = ""
        self.deployed(study_yaml())
        self.source_study(study_yaml("6", "About 90 minutes."))
        self.run_deploy()
        self.assertEqual((self.survey / "study/study.yaml").read_bytes(), study_yaml("6", "About 90 minutes."))
        self.assertNotIn("SURVEY_ACTIVATION_FROM", self.host.environment())
        self.assertFalse((self.survey / "activations").exists())

    def test_a_request_cannot_ride_along_a_first_activation_or_a_fresh_deployment(self):
        self.host.active = ""
        self.deployed(study_yaml())
        new = study_yaml("6")
        self.source_study(new, request_for(new))
        with self.assertRaisesRegex(ValueError, "activates the first one"):
            self.run_deploy()
        with self.assertRaisesRegex(ValueError, "running deployment only"), \
                mock.patch.object(deploy, "SURVEY", self.base / "fresh"):
            self.run_deploy()


if __name__ == "__main__":
    unittest.main()
