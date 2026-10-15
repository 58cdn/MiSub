import datetime
import contextlib
import io
import json
import unittest
from unittest import mock

import probe_version as version
import release_preflight as preflight
import release_recovery as recovery


class ProbeVersionTests(unittest.TestCase):
    def test_exact_calendar_and_sequence(self):
        for value in ("0.0.1.261015.1", "0.0.1.000229.999999", "0.0.1.240229.10", "0.0.1.991231.2"):
            with self.subTest(value=value):
                self.assertIsNotNone(version.dated_parts(value))
                self.assertTrue(version.valid(value))
        for value in ("0.0.1.230229.1", "0.0.1.261332.1", "0.0.1.260000.1", "0.0.1.260431.1", "0.0.1.261015.0", "0.0.1.261015.01", "0.0.1.261015.1000000", "0.0.1.261015.1\n", "0.0.1.261015.1-dev", "v0.0.1.261015.1", "0.0.1.261015.1;echo", None):
            with self.subTest(value=value):
                self.assertFalse(version.valid(value))
        self.assertTrue(version.valid("0.1.0"))
        self.assertTrue(version.valid("0.2.0"))

    def test_utc8_union_maximum_uses_tags_drafts_and_releases_not_count(self):
        instant = datetime.datetime(2026, 10, 14, 16, 0, tzinfo=datetime.timezone.utc)
        tags = ["probe-v0.0.1.261015.2", "probe-v0.0.1.261015.10", "probe-v0.0.1.261014.99"]
        releases = ["probe-v0.0.1.261015.8", "probe-v0.0.1.261015.10", "probe-v0.2.0"]
        self.assertEqual(version.next_version(tags, releases, instant), "0.0.1.261015.11")
        self.assertEqual(version.next_version([], [], instant - datetime.timedelta(seconds=1)), "0.0.1.261014.1")
        self.assertEqual(version.next_version([], [], instant), "0.0.1.261015.1")
        with self.assertRaisesRegex(ValueError, "exhausted"):
            version.next_version(["probe-v0.0.1.261015.999999"], [], instant)
        with self.assertRaisesRegex(ValueError, "timezone_required"):
            version.next_version([], [], datetime.datetime(2026, 10, 15))

    def test_preflight_rejects_changed_sha_collisions_and_wrong_date(self):
        commit = "a" * 40
        instant = datetime.datetime(2026, 10, 14, 17, 0, tzinfo=datetime.timezone.utc)
        self.assertTrue(preflight.verify("0.0.1.261015.1", commit, commit, commit, [], [], instant)["publicationReady"])
        for actual, main, tags, candidate in [("b"*40, commit, [], "0.0.1.261015.1"), (commit, "b"*40, [], "0.0.1.261015.1"), (commit, commit, ["probe-v0.0.1.261015.1"], "0.0.1.261015.1"), (commit, commit, [], "0.0.1.261014.1")]:
            with self.assertRaises(ValueError):
                preflight.verify(candidate, commit, actual, main, tags, [], instant)

    def test_prepublication_main_read_fails_closed(self):
        with mock.patch.object(preflight, "api", return_value={"object": {"sha": "b" * 40}}):
            with self.assertRaisesRegex(ValueError, "commit_changed"):
                preflight.verify_live_main("a" * 40)

    def test_dispatch_cli_keeps_original_run_date_across_midnight(self):
        commit = "a" * 40
        environment = {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": "58cdn/MiSub", "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": commit, "GITHUB_RUN_ID": "123"}
        def remote(endpoint, paginated=False):
            return {"actions/runs/123": {"created_at": "2026-10-14T17:12:00Z"}, "git/ref/heads/main": {"object": {"sha": commit}}, "git/matching-refs/tags/": [], "releases?per_page=100": []}[endpoint]
        output = io.StringIO()
        with mock.patch.dict(preflight.os.environ, environment, clear=True), mock.patch.object(preflight, "api", side_effect=remote), mock.patch("sys.argv", ["release_preflight.py", "--version", "0.0.1.261015.1", "--expected-commit", commit]), contextlib.redirect_stdout(output):
            self.assertEqual(preflight.main(), 0)
        self.assertEqual(json.loads(output.getvalue())["version"], "0.0.1.261015.1")

    def test_dated_draft_recovery_keeps_original_identity_and_rechecks_main(self):
        with mock.patch.object(preflight, "api", return_value={"object": {"sha": "b" * 40}}) as api:
            with self.assertRaisesRegex(ValueError, "commit_changed"):
                recovery.guard_dated_recovery("0.0.1.240229.2", "a" * 40)
            api.assert_called_once_with("git/ref/heads/main")
        with mock.patch.object(preflight, "api", return_value={"object": {"sha": "a" * 40}}):
            recovery.guard_dated_recovery("0.0.1.240229.2", "a" * 40)

    def test_inventory_pagination_keeps_every_page_and_network_errors(self):
        with mock.patch.object(preflight.subprocess, "run", return_value=mock.Mock(stdout=b'[[{"tag_name":"one"}],[{"tag_name":"two"}]]')) as run:
            self.assertEqual(len(preflight.api("releases?per_page=100", True)), 2)
            self.assertIn("--paginate", run.call_args.args[0])
        with mock.patch.object(preflight.subprocess, "run", side_effect=OSError("offline")):
            with self.assertRaises(OSError):
                preflight.api("releases?per_page=100", True)


if __name__ == "__main__":
    unittest.main()
