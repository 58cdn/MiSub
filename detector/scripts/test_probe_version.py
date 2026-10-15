import contextlib
import io
import json
import pathlib
import tempfile
import unittest
from unittest import mock

import probe_version as version
import release_preflight as preflight
import release_recovery as recovery


class ProbeVersionTests(unittest.TestCase):
    def test_alpha_product_identity_is_exact(self):
        for value in ("0.0.1-alpha.1", "0.0.1-alpha.10", "0.0.1-alpha.1000000", "0.0.1-alpha." + "9" * 52):
            with self.subTest(value=value):
                self.assertIsNotNone(version.alpha_number(value))
                self.assertTrue(version.valid(value))
        for value in ("0.0.1-alpha.0", "0.0.1-alpha.01", "0.0.1-alpha.-1", "0.0.1-beta.1", "0.0.1-rc.1", "0.0.2-alpha.1",
                      "0.0.1-alpha.1\n", "v0.0.1-alpha.1", "0.0.1-alpha.1+build", "0.0.1-alpha.1.sha.abcdef123456",
                      "0.0.1.261015.1", "0.0.1-alpha." + "9" * 53, None):
            with self.subTest(value=value):
                self.assertIsNone(version.alpha_number(value))
        for legacy in ("0.1.0", "0.2.0", "0.3.0"):
            self.assertTrue(version.valid(legacy))
            with self.assertRaisesRegex(ValueError, "explicit_legacy_migration"):
                version.compare_alpha(legacy, "0.0.1-alpha.1")

    def test_full_semver_numeric_and_prerelease_precedence(self):
        ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta",
                   "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "1.1.0", "1.10.0", "2.0.0"]
        for before, after in zip(ordered, ordered[1:]):
            self.assertEqual(version.compare(before, after), -1)
            self.assertEqual(version.compare(after, before), 1)
        self.assertEqual(version.compare("0.0.1-alpha.9", "0.0.1-alpha.10"), -1)
        self.assertEqual(version.compare("0.0.1-alpha.10+one", "0.0.1-alpha.10+two"), 0)
        for invalid in ("01.0.0", "0.0.1-alpha.01", "0.0.1-", "0.0.1+a..b", "0.0.1\n"):
            self.assertIsNone(version.parse(invalid))

    def test_development_sha_is_identity_only(self):
        base = "0.0.1-alpha.10"
        for suffix in ("abcdef123456", "000000000001", "123456789123"):
            self.assertEqual(version.alpha_number(base + ".sha." + suffix, True), 10)
            self.assertEqual(version.compare_alpha(base, base + ".sha." + suffix), 0)
            self.assertIsNone(version.alpha_number(base + ".sha." + suffix))
        self.assertEqual(version.compare_alpha("0.0.1-alpha.9.sha.ffffffffffff", base + ".sha.000000000001"), -1)
        largest_product = "0.0.1-alpha." + "9" * 52
        self.assertEqual(version.alpha_number(largest_product + ".sha.abcdef123456", True), int("9" * 52))
        for invalid in (base + ".sha.abcdef1", base + ".sha.ABCDEF123456", base + ".sha.abcdef123456.extra"):
            self.assertIsNone(version.alpha_number(invalid, True))

    def test_union_maximum_includes_tags_drafts_and_development_identity(self):
        tags = ["probe-v0.0.1-alpha.2", "probe-v0.0.1-alpha.10", "probe-v0.0.1-alpha.9.sha.abcdef123456"]
        releases = ["probe-v0.0.1-alpha.8", "probe-v0.0.1-alpha.12", "probe-v0.2.0"]
        self.assertEqual(version.next_version(tags, releases), "0.0.1-alpha.13")
        self.assertEqual(version.next_version([], []), "0.0.1-alpha.1")
        self.assertEqual(version.next_version(["probe-v0.0.1-alpha.999999"], []), "0.0.1-alpha.1000000")
        self.assertEqual(version.next_version(["probe-v0.0.1-alpha.9007199254740992"], []), "0.0.1-alpha.9007199254740993")

    def test_other_components_and_historical_tags_do_not_allocate_probe_numbers(self):
        names = ["v0.0.1-alpha.99", "v0.0.1-alpha.999.sha.abcdef123456", "0.0.1-alpha.10", "probe-v0.1.0", "probe-v0.2.0", "probe-v0.3.0"]
        self.assertEqual(version.next_version(names, names), "0.0.1-alpha.1")
        for malformed in (None, "probe-v0.0.1-alpha.01", "probe-v0.0.1-alpha.1+build"):
            with self.assertRaises(ValueError):
                version.next_version([malformed], [])

    def test_source_version_is_exact_and_cannot_be_overridden_by_dispatch(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root) / "detector/VERSION"
            path.parent.mkdir()
            for payload in (b"0.0.1-alpha.11", b"0.0.1-alpha.11\n", b"0.0.1-alpha.11\r\n"):
                path.write_bytes(payload)
                self.assertEqual(version.read_version(root), "0.0.1-alpha.11")
                version.verify_source_version("0.0.1-alpha.11", root)
                with self.assertRaisesRegex(ValueError, "source_product_version_mismatch"):
                    version.verify_source_version("0.0.1-alpha.12", root)
            for payload in (b"0.0.1-alpha.11 ", b"0.0.1-alpha.11\n\n", b"0.2.0\n", b"0.0.1-alpha.11.sha.abcdef123456\n"):
                path.write_bytes(payload)
                with self.assertRaisesRegex(ValueError, "invalid_source_product_version"):
                    version.read_version(root)

    def test_preflight_rejects_changed_sha_collisions_resets_and_skips(self):
        commit = "a" * 40
        self.assertTrue(preflight.verify("0.0.1-alpha.1", commit, commit, commit, [], [])["publicationReady"])
        for actual, main, tags, candidate in [("b"*40, commit, [], "0.0.1-alpha.1"),
                (commit, "b"*40, [], "0.0.1-alpha.1"), (commit, commit, ["probe-v0.0.1-alpha.1"], "0.0.1-alpha.1"),
                (commit, commit, ["probe-v0.0.1-alpha.10"], "0.0.1-alpha.2"), (commit, commit, [], "0.0.1-alpha.2"),
                (commit, commit, [], "0.2.0")]:
            with self.assertRaises(ValueError):
                preflight.verify(candidate, commit, actual, main, tags, [])

    def test_reserved_identity_cannot_publish_after_higher_number_or_without_tag(self):
        for tags, releases in [([], []), (["probe-v0.0.1-alpha.1"], ["probe-v0.0.1-alpha.2"]),
                               (["probe-v0.0.1-alpha.1", "probe-v0.0.1-alpha.3"], [])]:
            with mock.patch.object(preflight, "inventory", return_value=(tags, releases)), self.assertRaisesRegex(ValueError, "latest_sequence"):
                preflight.verify_reserved_version("0.0.1-alpha.1")
        with mock.patch.object(preflight, "inventory", return_value=(["probe-v0.0.1-alpha.1"], ["probe-v0.0.1-alpha.1"])):
            preflight.verify_reserved_version("0.0.1-alpha.1")

    def test_prepublication_main_read_fails_closed(self):
        with mock.patch.object(preflight, "api", return_value={"object": {"sha": "b" * 40}}):
            with self.assertRaisesRegex(ValueError, "commit_changed"):
                preflight.verify_live_main("a" * 40)

    def test_dispatch_cli_uses_complete_namespace_inventory(self):
        commit = "a" * 40
        environment = {"GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": "58cdn/MiSub", "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": commit}
        def remote(endpoint, paginated=False):
            return {"git/ref/heads/main": {"object": {"sha": commit}},
                    "git/matching-refs/tags/": [{"ref": "refs/tags/probe-v0.0.1-alpha.9"}, {"ref": "refs/tags/v0.0.1-alpha.999"}],
                    "releases?per_page=100": [{"tag_name": "probe-v0.0.1-alpha.10", "draft": True}]}[endpoint]
        output = io.StringIO()
        with mock.patch.dict(preflight.os.environ, environment, clear=True), mock.patch.object(version, "read_version", return_value="0.0.1-alpha.11"), mock.patch.object(preflight, "api", side_effect=remote), mock.patch("sys.argv", ["release_preflight.py", "--version", "0.0.1-alpha.11", "--expected-commit", commit]), contextlib.redirect_stdout(output):
            self.assertEqual(preflight.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {"version": "0.0.1-alpha.11", "commit": commit, "channel": "testing", "prerelease": True, "publicationReady": True})

    def test_alpha_draft_recovery_rechecks_main_and_reserved_sequence(self):
        with mock.patch.object(preflight, "verify_live_main", side_effect=ValueError("commit_changed")), mock.patch.object(preflight, "verify_reserved_version") as reserved:
            with self.assertRaisesRegex(ValueError, "commit_changed"):
                recovery.guard_alpha_recovery("0.0.1-alpha.2", "a" * 40)
            reserved.assert_not_called()
        with mock.patch.object(preflight, "verify_live_main") as main, mock.patch.object(preflight, "verify_reserved_version") as reserved:
            recovery.guard_alpha_recovery("0.0.1-alpha.2", "a" * 40)
            main.assert_called_once_with("a" * 40)
            reserved.assert_called_once_with("0.0.1-alpha.2")
            for legacy in ("0.1.0", "0.2.0", "0.3.0"):
                with self.assertRaisesRegex(ValueError, "alpha_release_version_required"):
                    recovery.guard_alpha_recovery(legacy, "a" * 40)

    def test_malformed_inventory_never_means_first_alpha_version(self):
        for tags, releases in [([{"ref": None}], []), ([{"ref": "refs/heads/main"}], []),
                               ([{"ref": "refs/tags/"}], []), ([{}], []), ([], [{"tag_name": None}]),
                               ([], [{"tag_name": ""}]), ([], [None])]:
            with self.subTest(tags=tags, releases=releases), mock.patch.object(preflight, "api", side_effect=[tags, releases]):
                with self.assertRaisesRegex(ValueError, "inventory"):
                    preflight.inventory()

    def test_inventory_pagination_keeps_every_page_and_network_errors(self):
        with mock.patch.object(preflight.subprocess, "run", return_value=mock.Mock(stdout=b'[[{"tag_name":"one"}],[{"tag_name":"two"}]]')) as run:
            self.assertEqual(len(preflight.api("releases?per_page=100", True)), 2)
            self.assertIn("--paginate", run.call_args.args[0])
        with mock.patch.object(preflight.subprocess, "run", side_effect=OSError("offline")):
            with self.assertRaises(OSError):
                preflight.api("releases?per_page=100", True)
        with mock.patch.object(preflight.subprocess, "run", return_value=mock.Mock(stdout=b'{"message":"not inventory"}')):
            with self.assertRaisesRegex(ValueError, "invalid_remote_inventory"):
                preflight.api("releases?per_page=100", True)


if __name__ == "__main__":
    unittest.main()
