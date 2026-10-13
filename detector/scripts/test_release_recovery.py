import copy
import gzip
import io
import json
import pathlib
import sys
import tarfile
import tempfile
import unittest
from unittest import mock

import release_gate as gate
import release_recovery as recovery
import source_build as source

VERSION, COMMIT = "0.2.0", "a" * 40
RUN_ID, DRAFT_ID, REPOSITORY_ID, ATTEMPT = 72, 123, 456, 1
STAMP = "2026-01-01T00:00:00Z"


def proof():
    workflow = "https://github.com/" + gate.REPOSITORY + "/" + gate.WORKFLOW + "@refs/heads/main"
    return [{"verificationResult": {"signature": {"certificate": {
        "runInvocationURI": "https://github.com/58cdn/MiSub/actions/runs/72/attempts/1",
        "buildTrigger": "workflow_dispatch", "runnerEnvironment": "github-hosted",
        "buildSignerDigest": COMMIT, "sourceRepositoryDigest": COMMIT,
        "sourceRepositoryURI": "https://github.com/58cdn/MiSub", "sourceRepositoryRef": "refs/heads/main",
        "sourceRepositoryIdentifier": str(REPOSITORY_ID), "buildConfigDigest": COMMIT,
        "issuer": "https://token.actions.githubusercontent.com", "buildSignerURI": workflow, "buildConfigURI": workflow}}}}]


def run_fixture():
    return {"id": RUN_ID, "event": "workflow_dispatch", "head_sha": COMMIT, "head_branch": "main", "path": gate.WORKFLOW,
            "status": "completed", "conclusion": "failure", "run_attempt": ATTEMPT,
            "repository": {"full_name": gate.REPOSITORY, "id": REPOSITORY_ID},
            "head_repository": {"full_name": gate.REPOSITORY, "id": REPOSITORY_ID},
            "url": recovery.API + "actions/runs/" + str(RUN_ID)}


def jobs_fixture():
    names = ["fixtures", *("native (" + recovery.RUNNERS[target] + ", " + target + ")" for target in gate.TARGETS), "publish"]
    jobs = [{"name": name, "run_id": RUN_ID, "run_attempt": ATTEMPT, "status": "completed", "conclusion": "success"} for name in names]
    jobs[-1].update(conclusion="failure", steps=[{"name": name, "status": "completed", "conclusion": "success"}
                                                for name in recovery.PUBLISH_STEPS])
    return {"total_count": 7, "jobs": jobs}


def tag_fixture():
    return {"ref": "refs/tags/probe-v" + VERSION, "object": {"type": "commit", "sha": COMMIT},
            "url": recovery.API + "git/refs/tags/probe-v" + VERSION}


def tar_bytes(files, prefix="", comment=None):
    output = io.BytesIO()
    options = {"format": tarfile.PAX_FORMAT, "pax_headers": {"comment": comment}} if comment else {"format": tarfile.GNU_FORMAT}
    with tarfile.open(fileobj=output, mode="w", **options) as archive:
        for name, data, mode in files:
            info = tarfile.TarInfo(prefix + name)
            info.size, info.mode = len(data), mode
            archive.addfile(info, io.BytesIO(data))
    return gzip.compress(output.getvalue(), mtime=0)


class FakeGitHub:
    def __init__(self, directory, release):
        self.directory, self.release = directory, copy.deepcopy(release)
        self.run, self.jobs, self.tag = run_fixture(), jobs_fixture(), tag_fixture()
        self.requests, self.downloads, self.proofs = [], [], []
        self.published = False
        self.change_after_proofs = None

    def json(self, endpoint, fields=()):
        self.requests.append((endpoint, tuple(fields)))
        if fields:
            assert endpoint == gate.release_endpoint(DRAFT_ID)
            assert tuple(fields) == ("-F", "draft=false", "-f", "make_latest=false")
            self.published = True
            self.release.update(draft=False, published_at=STAMP)
            return copy.deepcopy(self.release)
        if endpoint.endswith("/actions/runs/72"):
            if self.change_after_proofs and len(self.proofs) == 26:
                self.change_after_proofs(self)
                self.change_after_proofs = None
            return copy.deepcopy(self.run)
        if "/attempts/" in endpoint:
            return copy.deepcopy(self.jobs)
        if "/git/ref/" in endpoint:
            return copy.deepcopy(self.tag)
        if endpoint == gate.release_endpoint(DRAFT_ID):
            return copy.deepcopy(self.release)
        if endpoint.endswith("/assets?per_page=100"):
            return copy.deepcopy(self.release["assets"])
        raise AssertionError("Unexpected endpoint: " + endpoint)

    def asset(self, asset_id, destination, maximum):
        self.downloads.append(asset_id)
        asset = next(item for item in self.release["assets"] if item["id"] == asset_id)
        destination.write_bytes((self.directory / asset["name"]).read_bytes())

    def provenance(self, path, commit, run_id, attempt, repository_id):
        self.proofs.append(path.name)
        return {"fileName": path.name, "runInvocationURI": recovery.verify_invocation(proof(), commit, run_id, attempt, repository_id)}


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.source = self.root / "old-source"
        (self.source / "detector").mkdir(parents=True)
        self.lock = source.load_lock(gate.ROOT / "detector/source-build-lock.json")
        gate.save(self.source / "detector/source-build-lock.json", self.lock)
        self.lock_sha = source.digest(source.json_bytes(self.lock))
        self.wrapper_files = [("LICENSE", b"Fixture MIT license\n", 0o644),
            ("detector/bootstrap/install.sh", b"readonly MISUB_RELEASE_VERSION=''\nreadonly MISUB_RELEASE_COMMIT=''\nreadonly MISUB_RELEASE_ASSETS=''\n", 0o644),
            ("detector/bootstrap/install.ps1", b"$MisubReleaseVersion = ''\n$MisubReleaseCommit = ''\n$MisubReleaseSize = 0\n$MisubReleaseSha256 = ''\n", 0o644)]
        self.tree = source.git_tree(self.wrapper_files)
        self.wrapper_pack = tar_bytes(self.wrapper_files, "wrapper/", COMMIT)
        members = [("mihomo/main.go", b"Fixture full core source\n", 0o644), ("mihomo/LICENSE", b"Fixture full core license\n", 0o644),
                   ("go/src/runtime/main.go", b"Fixture runtime source\n", 0o644), ("go/LICENSE", b"Fixture toolchain license\n", 0o644)]
        inventory = {name: {"path": name, "sha256": source.digest(data), "bytes": len(data)} for name, data, _ in members}
        review = {"schemaVersion": 1, "sourceLockSha256": self.lock_sha, "reviews": [
            {"scope": scope, "inputFiles": [inventory[name]], "notices": [inventory[notice]], "rationale": "Synthetic fixture with full matching source and license bytes."}
            for scope, name, notice in (("mihomo", "mihomo/main.go", "mihomo/LICENSE"), ("go", "go/src/runtime/main.go", "go/LICENSE"))]}
        gate.save(self.source / "detector/source-license-review.json", review)
        manifest = {"schemaVersion": 1, "kind": "misub-core-source-pack", "source": self.lock["source"],
                    "lockSha256": self.lock_sha, "modules": [], "files": list(inventory.values())}
        source_pack = tar_bytes(members + [("manifest.json", source.json_bytes(manifest), 0o644)])
        core_linked, wrapper_linked = [inventory["mihomo/main.go"]], [inventory["go/src/runtime/main.go"]]
        coverage = gate.review_coverage(review, inventory, core_linked + wrapper_linked, self.lock_sha, [])
        inputs = self.root / "input"
        for target in gate.TARGETS:
            candidate = inputs / ("source-candidate-" + target)
            candidate.mkdir(parents=True)
            binary = candidate / ("misub-probe-" + target + (".exe" if target == "windows-amd64" else ""))
            binary.write_bytes(b"Synthetic never-executed fixture binary: " + target.encode())
            wrapper = candidate / ("misub-wrapper-source-" + target + ".tar.gz")
            wrapper.write_bytes(self.wrapper_pack)
            core = candidate / ("mihomo-source-" + target + ".tar.gz")
            core.write_bytes(source_pack)
            evidence = {"schemaVersion": 1, "kind": "misub-native-source-candidate", "version": VERSION, "commit": COMMIT,
                        "target": target, "wrapperTree": self.tree, "lockSha256": self.lock_sha, "materialBlockers": [],
                        "coverage": coverage, "capabilities": f"misub-probe-bootstrap-v1 {VERSION} {COMMIT} {target}",
                        "nativeTests": {"race": True, "requiredCoreTests": sorted(gate.CORE_TESTS), "passed": 4},
                        "asset": gate.record(binary), "wrapperSource": gate.record(wrapper), "coreSource": gate.record(core),
                        "wrapperStandardDependencies": wrapper_linked,
                        "coreBuild": {"kind": "misub-core-build", "source": self.lock["source"], "lockSha256": self.lock_sha,
                                      "target": target, "host": target, "caMode": "system", "repeatBuildMatches": True,
                                      "dependencies": {"files": core_linked}}}
            gate.save(candidate / ("evidence-" + target + ".json"), evidence)
        self.assets = self.root / "release"
        with self.snapshot_patch():
            gate.assemble_materials(self.source, inputs, self.assets, VERSION, COMMIT)
        self.release = {"id": DRAFT_ID, "url": recovery.API + "releases/123", "draft": True, "tag_name": "probe-v" + VERSION,
                        "prerelease": False, "published_at": None, "target_commitish": "main", "name": "MiSub Probe v" + VERSION,
                        "body": (self.assets / "SOURCE.md").read_text(), "updated_at": STAMP, "created_at": STAMP,
                        "upload_url": "https://uploads.github.com/repos/58cdn/MiSub/releases/123/assets{?name,label}",
                        "assets": [{"id": 1000 + index, "url": recovery.API + "releases/assets/" + str(1000 + index),
                                    "name": path.name, "size": path.stat().st_size, "digest": "sha256:" + gate.record(path)["sha256"],
                                    "state": "uploaded", "updated_at": STAMP, "download_count": 0}
                                   for index, path in enumerate(sorted(self.assets.iterdir()))]}
        self.client = FakeGitHub(self.assets, self.release)

    def tearDown(self):
        self.temp.cleanup()

    def snapshot_patch(self):
        return mock.patch.object(gate, "wrapper_snapshot", return_value=(self.wrapper_pack, self.wrapper_files, self.tree))

    def recover(self, publish=False, work="recovered"):
        with self.snapshot_patch(), mock.patch.object(recovery, "code_identity", return_value={"commit": "b" * 40, "tree": "c" * 40}), \
             mock.patch.object(recovery, "GitHub", return_value=self.client):
            return recovery.recover(self.source, self.root / work, VERSION, COMMIT, RUN_ID, DRAFT_ID, ATTEMPT, publish)

    def assert_no_write(self):
        self.assertFalse(self.client.published)
        self.assertFalse(any(fields for _, fields in self.client.requests))

    def test_default_verifies_all_26_actual_assets_and_never_writes(self):
        result = self.recover()
        self.assertTrue(result["verified"])
        self.assertFalse(result["published"])
        self.assertEqual(len(self.client.downloads), 26)
        self.assertEqual(set(self.client.proofs), recovery.expected_names())
        self.assertEqual(result["sourceCommit"], COMMIT)
        self.assertEqual(result["recoveryCode"]["commit"], "b" * 40)
        self.assert_no_write()
        self.assertFalse(any("/releases/tags/" in endpoint for endpoint, _ in self.client.requests))

    def test_explicit_publish_only_patches_same_id_then_rereads_tag_and_id(self):
        result = self.recover(publish=True)
        self.assertTrue(result["published"])
        writes = [(endpoint, fields) for endpoint, fields in self.client.requests if fields]
        self.assertEqual(writes, [(gate.release_endpoint(DRAFT_ID), ("-F", "draft=false", "-f", "make_latest=false"))])
        self.assertEqual(self.client.requests[-2:], [("repos/58cdn/MiSub/git/ref/tags/probe-v0.2.0", ()), (gate.release_endpoint(DRAFT_ID), ())])

    def test_post_publication_read_failure_reports_unknown_without_retry_or_rollback(self):
        original = self.client.json

        def fail_after_patch(endpoint, fields=()):
            if self.client.published and not fields:
                raise OSError("Fixture read failure after successful PATCH")
            return original(endpoint, fields)

        self.client.json = fail_after_patch
        with self.assertRaises(recovery.PublicationUncertain):
            self.recover(publish=True)
        self.assertTrue(self.client.published)
        self.assertEqual(len([fields for _, fields in self.client.requests if fields]), 1)
        attempt = gate.read_json(self.root / "recovered/publication-attempt.json")
        self.assertIsNone(attempt["published"])
        self.assertTrue(attempt["publicationAttempted"])
        self.assertFalse((self.root / "recovered/published.json").exists())

    def test_wrong_attempt_is_rejected_before_download(self):
        self.client.run["run_attempt"] = 2
        with self.assertRaisesRegex(gate.GateError, "run_attempt"):
            self.recover(publish=True)
        self.assertEqual(self.client.downloads, [])
        self.assert_no_write()

    def test_source_checkout_mismatch_stops_before_remote_access(self):
        with mock.patch.object(recovery, "code_identity", return_value={}), mock.patch.object(gate, "wrapper_snapshot", side_effect=gate.GateError("checkout_commit_mismatch")), \
             mock.patch.object(recovery, "GitHub") as api:
            with self.assertRaises(gate.GateError):
                recovery.recover(self.source, self.root / "bad", VERSION, COMMIT, RUN_ID, DRAFT_ID, ATTEMPT, True)
            api.assert_not_called()

    def test_real_byte_tampering_stops_before_provenance_or_patch(self):
        (self.assets / "misub-probe-linux-amd64").write_bytes(b"tampered")
        with self.assertRaisesRegex(gate.GateError, "artifact_digest"):
            self.recover(publish=True)
        self.assertEqual(self.client.proofs, [])
        self.assert_no_write()

    def test_failed_signature_cannot_publish(self):
        self.client.provenance = mock.Mock(side_effect=gate.GateError("invalid_signature"))
        with self.assertRaisesRegex(gate.GateError, "invalid_signature"):
            self.recover(publish=True)
        self.assert_no_write()

    def test_full_material_validator_rechecks_source_core_and_template_bytes(self):
        workspace = self.root / "material-check"
        workspace.mkdir()
        evidence_path = self.assets / "evidence-linux-amd64.json"
        evidence = gate.read_json(evidence_path)
        evidence["coreBuild"]["repeatBuildMatches"] = False
        evidence_path.write_bytes(source.json_bytes(evidence))
        # Even a self-consistent replacement manifest/sums cannot bypass source-bound candidate checks.
        self.refresh_manifest()
        with self.snapshot_patch(), self.assertRaisesRegex(gate.GateError, "core_source_binding"):
            recovery.verify_materials(self.source, self.assets, workspace, VERSION, COMMIT)

    def refresh_manifest(self):
        path = self.assets / "release-manifest.json"
        manifest = gate.read_json(path)
        manifest["files"] = [gate.record(self.assets / record["fileName"]) for record in manifest["files"]]
        path.write_bytes(source.json_bytes(manifest))
        sums = "".join(gate.record(path)["sha256"] + "  " + path.name + "\n" for path in sorted(self.assets.iterdir(), key=lambda path: path.name) if path.name != "SHA256SUMS")
        (self.assets / "SHA256SUMS").write_text(sums, encoding="ascii", newline="\n")

    def test_altered_signed_bootstrap_metadata_is_rejected_against_original_template(self):
        workspace = self.root / "template-check"
        workspace.mkdir()
        (self.assets / "install.sh").write_bytes(b"unexpected rewritten bootstrap")
        self.refresh_manifest()
        with self.snapshot_patch(), self.assertRaisesRegex(gate.GateError, "artifact_digest"):
            recovery.verify_materials(self.source, self.assets, workspace, VERSION, COMMIT)

    def test_changed_remote_state_never_patches(self):
        mutations = [lambda client: client.release.update(updated_at="2026-01-02T00:00:00Z"),
                     lambda client: client.release["assets"][0].update(id=99999, url=recovery.API + "releases/assets/99999"),
                     lambda client: client.release["assets"][0].update(updated_at="2026-01-02T00:00:00Z"),
                     lambda client: client.release.update(body="changed"),
                     lambda client: client.tag["object"].update(sha="d" * 40),
                     lambda client: client.run.update(run_attempt=2),
                     lambda client: client.release.update(draft=False)]
        for index, mutation in enumerate(mutations):
            self.client = FakeGitHub(self.assets, self.release)
            self.client.change_after_proofs = mutation
            with self.subTest(index=index), self.assertRaises(gate.GateError):
                self.recover(publish=True, work="changed-" + str(index))
            self.assert_no_write()

    def test_download_counter_changes_do_not_rewrite_assets(self):
        self.client.change_after_proofs = lambda client: client.release["assets"][0].update(download_count=10)
        self.assertTrue(self.recover()["verified"])
        self.assert_no_write()

    def test_wrong_or_incomplete_draft_is_rejected_before_download(self):
        mutations = [lambda release: release.update(id=124), lambda release: release.update(draft=False),
                     lambda release: release.update(tag_name="probe-v9.9.9"), lambda release: release.update(published_at=STAMP),
                     lambda release: release.update(prerelease=True), lambda release: release["assets"].pop(),
                     lambda release: release["assets"].append(copy.deepcopy(release["assets"][0])),
                     lambda release: release["assets"][0].update(name="extra.exe"),
                     lambda release: release["assets"][0].update(size=True), lambda release: release["assets"][0].update(size=gate.MAX_FILE + 1),
                     lambda release: release["assets"][0].update(digest="bad"), lambda release: release["assets"][0].update(state="new")]
        for index, mutation in enumerate(mutations):
            self.client = FakeGitHub(self.assets, self.release)
            mutation(self.client.release)
            with self.subTest(index=index), self.assertRaises(gate.GateError):
                self.recover(publish=True, work="invalid-" + str(index))
            self.assertEqual(self.client.downloads, [])
            self.assert_no_write()

    def test_body_must_match_verified_source_document(self):
        self.client.release["body"] = "modified release instructions"
        with self.assertRaisesRegex(gate.GateError, "body_source"):
            self.recover(publish=True)
        self.assert_no_write()

    def test_original_run_requires_canonical_manual_source_and_successful_producers(self):
        for key, value in (("event", "push"), ("head_sha", "b" * 40), ("head_branch", "other"), ("path", "other.yml"),
                           ("status", "in_progress"), ("conclusion", "cancelled")):
            changed = run_fixture()
            changed[key] = value
            with self.subTest(key=key), self.assertRaises(gate.GateError):
                recovery.verify_run(changed, RUN_ID, COMMIT, ATTEMPT)
        for mutation in (lambda jobs: jobs["jobs"][0].update(conclusion="failure"), lambda jobs: jobs["jobs"].pop(),
                         lambda jobs: jobs["jobs"][-1]["steps"][0].update(conclusion="skipped")):
            changed = jobs_fixture()
            mutation(changed)
            with self.assertRaises(gate.GateError):
                recovery.verify_jobs(changed, RUN_ID, ATTEMPT)

    def test_only_authenticated_certificate_fields_bind_original_invocation(self):
        expected = recovery.verify_invocation(proof(), COMMIT, RUN_ID, ATTEMPT, REPOSITORY_ID)
        self.assertTrue(expected.endswith("/72/attempts/1"))
        for key in proof()[0]["verificationResult"]["signature"]["certificate"]:
            changed = proof()
            changed[0]["verificationResult"]["signature"]["certificate"][key] = "forged"
            changed[0]["verified"] = True
            changed[0]["predicate"] = {"invocationId": expected}
            with self.subTest(key=key), self.assertRaisesRegex(gate.GateError, "invocation"):
                recovery.verify_invocation(changed, COMMIT, RUN_ID, ATTEMPT, REPOSITORY_ID)
        with self.assertRaises(gate.GateError):
            recovery.verify_invocation([{"verified": True, "predicate": {"invocationId": expected}}], COMMIT, RUN_ID, ATTEMPT, REPOSITORY_ID)

    def test_gh_verifier_uses_strict_flags_and_pins_api_hostname(self):
        logs = self.root / "api-logs"
        logs.mkdir()
        client = recovery.GitHub(logs)

        def response(command, destination, maximum, timeout):
            destination.write_bytes(source.json_bytes(proof() if command[1] == "attestation" else {}))

        with mock.patch.object(recovery, "bounded_command", side_effect=response) as runner:
            client.provenance(self.assets / "install.sh", COMMIT, RUN_ID, ATTEMPT, REPOSITORY_ID)
            command = runner.call_args.args[0]
            for option, value in (("--repo", gate.REPOSITORY), ("--source-ref", "refs/heads/main"), ("--source-digest", COMMIT),
                                  ("--signer-digest", COMMIT), ("--cert-oidc-issuer", "https://token.actions.githubusercontent.com"), ("--format", "json")):
                self.assertEqual(command[command.index(option) + 1], value)
            self.assertIn("--deny-self-hosted-runners", command)
            client.json(gate.release_endpoint(DRAFT_ID))
            self.assertEqual(runner.call_args.args[0][6], recovery.API + "releases/123")
            client.asset(1000, logs / "bytes", 10)
            self.assertEqual(runner.call_args.args[0][6], recovery.API + "releases/assets/1000")

    def test_bounded_download_rejects_oversize_and_timeout_without_retaining_partial_bytes(self):
        destination = self.root / "download"
        with self.assertRaisesRegex(gate.GateError, "limit"):
            recovery.bounded_command([sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'x'*100)"], destination, 8, 10)
        self.assertFalse(destination.exists())

    def test_existing_download_destination_is_preserved_without_starting_command(self):
        destination = self.root / "existing"
        destination.write_bytes(b"sentinel")
        with mock.patch.object(recovery.subprocess, "Popen") as command, self.assertRaises(FileExistsError):
            recovery.bounded_command([sys.executable, "-c", "pass"], destination, 8, 1)
        command.assert_not_called()
        self.assertEqual(destination.read_bytes(), b"sentinel")

    def test_download_timeout_removes_only_its_partial_file(self):
        destination = self.root / "timeout"
        with self.assertRaisesRegex(gate.GateError, "timeout"):
            recovery.bounded_command([sys.executable, "-c", "import time; time.sleep(5)"], destination, 8, 0.1)
        self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
