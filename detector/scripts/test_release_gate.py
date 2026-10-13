import copy
import gzip
import io
import json
import os
import pathlib
import sys
import tempfile
import tarfile
import unittest
from unittest import mock

import release_gate as gate
import source_build as source


VERSION = "0.2.0"
COMMIT = "a" * 40


def fixture_file(path, data=b"fixture full source or license text\n"):
    return {"path": path, "sha256": source.digest(data), "bytes": len(data)}


def context():
    return {"GITHUB_ACTIONS": "true", "GITHUB_EVENT_NAME": "workflow_dispatch", "GITHUB_REPOSITORY": "58cdn/MiSub",
            "GITHUB_REF": "refs/heads/main", "GITHUB_SHA": COMMIT, "MISUB_PUBLISH": "true",
            "GITHUB_WORKFLOW_REF": "58cdn/MiSub/.github/workflows/probe-source-release.yml@refs/heads/main"}


class ReleaseGateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_version_rejects_legacy_and_shell_input(self):
        for version in ("0.1.0", "0.2.0;touch x", "01.2.0", "v0.2.0", "0.2.0\n", "0.2.0-rc1"):
            with self.subTest(version=version), self.assertRaises(gate.GateError):
                gate.identity(version, COMMIT)
        gate.identity(VERSION, COMMIT)

    def test_release_only_from_exact_manual_main_context(self):
        gate.release_context(VERSION, COMMIT, context())
        for key in context():
            changed = context()
            changed[key] = "forged"
            with self.subTest(key=key), self.assertRaisesRegex(gate.GateError, "manual_main"):
                gate.release_context(VERSION, COMMIT, changed)

    def test_windows_bootstrap_uses_own_module_defaults_without_mutating_parent(self):
        parent = {"PSModulePath": "fixture-core-modules", "psmodulepath": "fixture-other-case", "PATH": "fixture-tools", "SystemRoot": "fixture-system"}
        child = gate.bootstrap_environment("windows-amd64", parent)
        self.assertEqual(child, {"PATH": "fixture-tools", "SystemRoot": "fixture-system"})
        self.assertEqual(parent["PSModulePath"], "fixture-core-modules")
        self.assertEqual(gate.bootstrap_environment("linux-amd64", parent), parent)

    @unittest.skipUnless(sys.platform == "win32", "Windows PowerShell module loading requires Windows")
    def test_windows_powershell_builtin_module_import_from_python(self):
        executable = pathlib.Path(os.environ["SystemRoot"]) / "System32/WindowsPowerShell/v1.0/powershell.exe"
        result = gate.subprocess.run([str(executable), "-NoProfile", "-NonInteractive", "-Command",
                                      "Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; (Get-Command Get-Acl -ErrorAction Stop).Name"],
                                     env=gate.bootstrap_environment("windows-amd64"), stdin=gate.subprocess.DEVNULL,
                                     stdout=gate.subprocess.PIPE, stderr=gate.subprocess.PIPE, check=True, timeout=30)
        self.assertEqual(result.stdout.strip(), b"Get-Acl")

    def review_fixture(self):
        main = fixture_file("mihomo/main.go")
        tool = fixture_file("go/src/runtime/proc.go")
        module = fixture_file("mihomo/vendor/example.com/lib/main.go")
        license_file = fixture_file("mihomo/LICENSE", b"full fixture license text\n")
        files = {f["path"]: f for f in (main, tool, module, license_file)}
        review = {"schemaVersion": 1, "sourceLockSha256": "b" * 64, "reviews": [
            {"scope": scope, "inputFiles": [entry], "notices": [license_file], "rationale": "Fixture-only explicit scope and notice mapping."}
            for scope, entry in (("mihomo", main), ("go", tool), ("example.com/lib", module))]}
        return review, files, [main, tool, module], [{"module": "example.com/lib"}]

    def test_license_coverage_binds_selected_files_and_full_notice_bytes(self):
        review, files, linked, modules = self.review_fixture()
        result = gate.review_coverage(review, files, linked, "b" * 64, modules)
        self.assertEqual(result["linkedFiles"], 3)
        self.assertEqual(len(result["reviewedScopes"]), 3)

    def test_ready_boolean_cannot_replace_review(self):
        review, files, linked, modules = self.review_fixture()
        review["ready"] = True
        with self.assertRaisesRegex(gate.GateError, "license_review_lock"):
            gate.review_coverage(review, files, linked, "b" * 64, modules)

    def test_review_rejects_missing_scopes_files_notice_and_wrong_lock(self):
        for mutation in (lambda r: r["reviews"].pop(),
                         lambda r: r["reviews"][0]["inputFiles"][0].update(sha256="f" * 64),
                         lambda r: r["reviews"][0].update(notices=[]),
                         lambda r: r["reviews"][0]["notices"][0].update(bytes=0),
                         lambda r: r.update(sourceLockSha256="c" * 64)):
            review, files, linked, modules = self.review_fixture()
            review = copy.deepcopy(review)
            mutation(review)
            with self.assertRaises(gate.GateError):
                gate.review_coverage(review, files, linked, "b" * 64, modules)

    def test_union_review_allows_verified_files_of_other_targets(self):
        review, files, linked, modules = self.review_fixture()
        extra = fixture_file("go/src/runtime/os_windows.go")
        files[extra["path"]] = extra
        review["reviews"][1]["inputFiles"].append(extra)
        gate.review_coverage(review, files, linked, "b" * 64, modules)
        del files[extra["path"]]
        with self.assertRaisesRegex(gate.GateError, "license_input"):
            gate.review_coverage(review, files, linked, "b" * 64, modules)

    def test_module_scope_uses_longest_actual_module_prefix(self):
        review, files, linked, modules = self.review_fixture()
        nested = fixture_file("mihomo/vendor/example.com/lib/nested/main.go")
        files[nested["path"]] = nested
        linked.append(nested)
        modules.append({"module": "example.com/lib/nested"})
        review["reviews"][2]["inputFiles"].append(nested)
        with self.assertRaisesRegex(gate.GateError, "without_reviewed_license"):
            gate.review_coverage(review, files, linked, "b" * 64, modules)

    def test_runtime_test_log_requires_actual_core_passes_and_package(self):
        events = [{"Action": "pass", "Test": name} for name in gate.CORE_TESTS] + [{"Action": "pass", "Package": "fixture"}]
        payload = b"\n".join(json.dumps(event).encode() for event in events)
        self.assertEqual(gate.verify_native_tests(payload)["passed"], 4)
        for changed in (events[:-1], events[1:], events + [{"Action": "fail", "Test": "OtherTest"}]):
            with self.assertRaisesRegex(gate.GateError, "native_core_tests"):
                gate.verify_native_tests(b"\n".join(json.dumps(event).encode() for event in changed))

    def test_native_test_skip_cannot_count_as_core_pass(self):
        events = [{"Action": "skip", "Test": name} for name in gate.CORE_TESTS] + [{"Action": "pass"}]
        with self.assertRaises(gate.GateError):
            gate.verify_native_tests(b"\n".join(json.dumps(event).encode() for event in events))

    def bootstrap_fixture(self):
        unix = "readonly MISUB_RELEASE_VERSION=''\nreadonly MISUB_RELEASE_COMMIT=''\nreadonly MISUB_RELEASE_ASSETS=''\n"
        windows = "$MisubReleaseVersion = ''\n$MisubReleaseCommit = ''\n$MisubReleaseSize = 0\n$MisubReleaseSha256 = ''\n"
        assets = {t: {"fileName": "misub-probe-" + t + (".exe" if t == "windows-amd64" else ""), "sha256": "c" * 64, "size": 1234} for t in gate.TARGETS}
        return unix, windows, assets

    def test_bootstrap_renderer_embeds_exact_platform_hashes_and_sizes(self):
        unix, windows, assets = self.bootstrap_fixture()
        sh, ps = gate.render_bootstrap(unix, windows, assets, VERSION, COMMIT)
        self.assertIn(b"darwin-arm64\t1234\t" + b"c" * 64, sh)
        self.assertNotIn(b"windows-amd64", sh)
        self.assertIn(b"$MisubReleaseSize = 1234", ps)
        self.assertIn(COMMIT.encode(), sh)
        self.assertIn(COMMIT.encode(), ps)

    def test_bootstrap_renderer_rejects_duplicate_marker_and_missing_target(self):
        unix, windows, assets = self.bootstrap_fixture()
        with self.assertRaisesRegex(gate.GateError, "marker"):
            gate.render_bootstrap(unix + "readonly MISUB_RELEASE_VERSION=''", windows, assets, VERSION, COMMIT)
        assets.pop("linux-arm64")
        with self.assertRaisesRegex(gate.GateError, "five_targets"):
            gate.render_bootstrap(unix, windows, assets, VERSION, COMMIT)

    def test_bootstrap_renderer_rejects_script_injection_and_invalid_size(self):
        for field, value in (("sha256", "';run bad'"), ("size", True), ("size", 0), ("fileName", "../other")):
            unix, windows, assets = self.bootstrap_fixture()
            assets["windows-amd64"][field] = value
            with self.assertRaisesRegex(gate.GateError, "invalid_bootstrap_asset"):
                gate.render_bootstrap(unix, windows, assets, VERSION, COMMIT)

    def pack(self, tamper=False, extra=None):
        data = b"complete fixture source bytes\n"
        entry = fixture_file("mihomo/main.go", data)
        manifest = {"schemaVersion": 1, "kind": "misub-core-source-pack", "files": [dict(entry, mode=0o644)]}
        if tamper:
            manifest["files"][0]["sha256"] = "0" * 64
        members = [("mihomo/main.go", data), ("manifest.json", source.json_bytes(manifest))]
        if extra:
            members.append(extra)
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as archive:
            for name, payload in members:
                item = tarfile.TarInfo(name)
                item.size = len(payload)
                archive.addfile(item, io.BytesIO(payload))
        path = self.root / "source.tar.gz"
        path.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
        return path

    def test_source_pack_rechecks_contents_not_manifest_claims(self):
        path = self.pack()
        files, manifest = gate.source_pack_inventory(path)
        self.assertEqual(files["mihomo/main.go"]["bytes"], 30)
        path = self.pack(tamper=True)
        with self.assertRaisesRegex(gate.GateError, "content_mismatch"):
            gate.source_pack_inventory(path)

    def test_source_pack_rejects_unlisted_and_duplicate_members(self):
        for extra in (("secret.txt", b"fixture"), ("MIHOMO/main.go", b"fixture")):
            path = self.pack(extra=extra)
            with self.assertRaises(gate.GateError):
                gate.source_pack_inventory(path)

    def test_wrapper_archive_requires_exact_full_git_tree(self):
        files = [("LICENSE", b"full license", 0o644), ("detector/main.go", b"package main", 0o644)]
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT, pax_headers={"comment": COMMIT}) as archive:
            for name, data, mode in files:
                item = tarfile.TarInfo("wrapper/" + name)
                item.size, item.mode = len(data), mode
                archive.addfile(item, io.BytesIO(data))
        path = self.root / "wrapper.tar.gz"
        path.write_bytes(gzip.compress(raw.getvalue(), mtime=0))
        gate.verify_wrapper_pack(path, COMMIT, source.git_tree(files))
        with self.assertRaisesRegex(gate.GateError, "identity_mismatch"):
            gate.verify_wrapper_pack(path, COMMIT, "0" * 40)

    def test_git_snapshot_preserves_blob_bytes_with_crlf_runner_configuration(self):
        repo = self.root / "fixture-repo"
        repo.mkdir()
        env = dict(os.environ, GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull,
                   GIT_CONFIG_COUNT="2", GIT_CONFIG_KEY_0="core.autocrlf", GIT_CONFIG_VALUE_0="true",
                   GIT_CONFIG_KEY_1="core.eol", GIT_CONFIG_VALUE_1="crlf",
                   GIT_AUTHOR_NAME="Fixture", GIT_AUTHOR_EMAIL="fixture@example.invalid",
                   GIT_COMMITTER_NAME="Fixture", GIT_COMMITTER_EMAIL="fixture@example.invalid",
                   GIT_AUTHOR_DATE="2000-01-01T00:00:00+0000", GIT_COMMITTER_DATE="2000-01-01T00:00:00+0000")

        def git(*args, data=None):
            return gate.subprocess.run(["git", "-C", str(repo), *args], input=data, stdout=gate.subprocess.PIPE,
                                       stderr=gate.subprocess.PIPE, env=env, check=True, timeout=30).stdout

        git("init", "--quiet")
        entries = []
        contents = {".gitattributes": b"* text=auto\n", "LICENSE": b"Full fixture license\nsecond line\n"}
        for name, data in contents.items():
            (repo / name).write_bytes(data)
            sha = git("hash-object", "-w", "--stdin", data=data).decode().strip()
            entries.append(f"100644 blob {sha}\t{name}\n")
        tree = git("mktree", data="".join(entries).encode()).decode().strip()
        commit = git("-c", "commit.gpgsign=false", "commit-tree", tree, data=b"Synthetic archive fixture\n").decode().strip()
        git("update-ref", "HEAD", commit)
        git("read-tree", "HEAD")
        converted = git("archive", "--format=tar.gz", "--prefix=wrapper/", commit)
        converted_files = list(source.archive_files(converted, "wrapper", "tar.gz", commit))
        self.assertNotEqual(source.git_tree(converted_files), tree)
        self.assertTrue(any(b"\r\n" in data for _, data, _ in converted_files))
        with mock.patch.dict(os.environ, env, clear=True):
            _, preserved, actual_tree = gate.wrapper_snapshot(repo, commit)
            self.assertEqual(actual_tree, tree)
            self.assertEqual({name: data for name, data, _ in preserved}, contents)
            (repo / "LICENSE").write_bytes(b"changed tracked content\n")
            with self.assertRaisesRegex(gate.GateError, "tracked_worktree_not_clean"):
                gate.wrapper_snapshot(repo, commit)

    def release_fixture(self):
        output = self.root / "release"
        output.mkdir()
        (output / "binary").write_bytes(b"synthetic fixture executable bytes, never run")
        manifest = {"schemaVersion": 1, "kind": "misub-source-release", "version": VERSION, "commit": COMMIT, "workflow": gate.WORKFLOW,
                    "files": [gate.record(output / "binary")], "provenancePolicy": gate.provenance_policy(COMMIT)}
        gate.save(output / "release-manifest.json", manifest)
        sums = "".join(gate.record(p)["sha256"] + "  " + p.name + "\n" for p in sorted(output.iterdir()))
        (output / "SHA256SUMS").write_text(sums, encoding="ascii", newline="\n")
        return output

    def test_final_file_verifier_rejects_added_or_changed_asset(self):
        output = self.release_fixture()
        self.assertEqual(len(gate.verify_release_files(output, VERSION, COMMIT)), 3)
        (output / "binary").write_bytes(b"tampered")
        with self.assertRaisesRegex(gate.GateError, "digest"):
            gate.verify_release_files(output, VERSION, COMMIT)

    def test_manifest_cannot_weaken_authenticated_source_policy(self):
        output = self.release_fixture()
        path = output / "release-manifest.json"
        manifest = gate.read_json(path)
        manifest["provenancePolicy"]["denySelfHostedRunners"] = False
        path.write_bytes(source.json_bytes(manifest))
        with self.assertRaisesRegex(gate.GateError, "policy_mismatch"):
            gate.verify_release_files(output, VERSION, COMMIT)

    def test_publish_cryptographically_verifies_every_file_with_fixed_identity(self):
        output = self.release_fixture()
        bundle = self.root / "bundle.jsonl"
        bundle.write_text("fixture bundle supplied only to a mocked gh verifier")
        with mock.patch.dict(gate.os.environ, context(), clear=True), mock.patch.object(gate, "run", return_value=b"") as run:
            names = gate.verify_provenance(output, VERSION, COMMIT, bundle, self.root / "logs")
        self.assertEqual(run.call_count, len(names))
        for call in run.call_args_list:
            args = call.args[0]
            self.assertEqual(args[:3], ["gh", "attestation", "verify"])
            for option, value in (("--source-digest", COMMIT), ("--signer-digest", COMMIT), ("--source-ref", "refs/heads/main"), ("--repo", gate.REPOSITORY)):
                self.assertEqual(args[args.index(option) + 1], value)
            self.assertIn("--deny-self-hosted-runners", args)

    def test_failed_attestation_prevents_any_release_api(self):
        with mock.patch.object(gate, "verify_provenance", side_effect=gate.GateError("signature_invalid")), mock.patch.object(gate.subprocess, "run") as api:
            with self.assertRaisesRegex(gate.GateError, "signature_invalid"):
                gate.publish(self.root, VERSION, COMMIT, self.root / "bundle", self.root / "logs")
            api.assert_not_called()

    def test_existing_tag_prevents_release_mutation(self):
        result = mock.Mock(stdout=json.dumps([[{"ref": "refs/tags/probe-v0.2.0"}]]).encode())
        with mock.patch.object(gate, "verify_provenance", return_value=["binary"]), mock.patch.object(gate.subprocess, "run", return_value=result), mock.patch.object(gate, "run") as mutate:
            with self.assertRaisesRegex(gate.GateError, "already_exists"):
                gate.publish(self.root, VERSION, COMMIT, self.root / "bundle", self.root / "logs")
            mutate.assert_not_called()

    def test_api_failure_cannot_mean_release_absent(self):
        error = gate.subprocess.CalledProcessError(1, ["gh", "api"])
        with mock.patch.object(gate, "verify_provenance", return_value=["binary"]), mock.patch.object(gate.subprocess, "run", side_effect=error), mock.patch.object(gate, "run") as mutate:
            with self.assertRaises(gate.subprocess.CalledProcessError):
                gate.publish(self.root, VERSION, COMMIT, self.root / "bundle", self.root / "logs")
            mutate.assert_not_called()

    def test_remote_asset_mismatch_cannot_publish_draft(self):
        output = self.release_fixture()
        names = gate.verify_release_files(output, VERSION, COMMIT)
        release = {"draft": True, "tag_name": "probe-v0.2.0", "assets": [
            {"name": name, "size": gate.record(output / name)["size"], "digest": "sha256:" + gate.record(output / name)["sha256"], "state": "uploaded"}
            for name in names]}
        release["assets"][0]["digest"] = "sha256:" + "0" * 64
        absent = mock.Mock(stdout=b"[[]]")
        with mock.patch.object(gate, "verify_provenance", return_value=names), mock.patch.object(gate.subprocess, "run", return_value=absent), mock.patch.object(gate, "run", side_effect=[b"{}", b"", json.dumps(release).encode()]) as mutate:
            with self.assertRaisesRegex(gate.GateError, "remote_asset"):
                gate.publish(output, VERSION, COMMIT, self.root / "bundle", self.root / "logs")
        self.assertEqual(mutate.call_count, 3)
        self.assertEqual(mutate.call_args_list[0].args[0][:4], ["gh", "api", "--method", "POST"])
        for call in mutate.call_args_list:
            self.assertNotIn("--force", call.args[0])
            self.assertNotIn("--draft=false", call.args[0])

    def test_tag_creation_race_failure_stops_before_release_create(self):
        absent = mock.Mock(stdout=b"[[]]")
        with mock.patch.object(gate, "verify_provenance", return_value=["binary"]), mock.patch.object(gate.subprocess, "run", return_value=absent), mock.patch.object(gate, "run", side_effect=gate.GateError("tag_already_exists")) as mutate:
            with self.assertRaisesRegex(gate.GateError, "tag_already_exists"):
                gate.publish(self.root, VERSION, COMMIT, self.root / "bundle", self.root / "logs")
            self.assertEqual(mutate.call_count, 1)

    def test_publish_requires_remote_exact_set_then_marks_only_new_draft_public(self):
        output = self.release_fixture()
        names = gate.verify_release_files(output, VERSION, COMMIT)
        release = {"draft": True, "tag_name": "probe-v0.2.0", "assets": [
            {"name": name, "size": gate.record(output / name)["size"], "digest": "sha256:" + gate.record(output / name)["sha256"], "state": "uploaded"}
            for name in names]}
        absent = mock.Mock(stdout=b"[[]]")
        with mock.patch.object(gate, "verify_provenance", return_value=names), mock.patch.object(gate.subprocess, "run", return_value=absent), mock.patch.object(gate, "run", side_effect=[b"{}", b"", json.dumps(release).encode(), b""]) as mutate:
            result = gate.publish(output, VERSION, COMMIT, self.root / "bundle", self.root / "logs")
        self.assertTrue(result["releaseReady"])
        self.assertEqual(mutate.call_count, 4)
        self.assertIn("--verify-tag", mutate.call_args_list[1].args[0])
        self.assertEqual(mutate.call_args_list[-1].args[0], ["gh", "release", "edit", "probe-v0.2.0", "--repo", gate.REPOSITORY, "--draft=false", "--latest=false"])


if __name__ == "__main__":
    unittest.main()
