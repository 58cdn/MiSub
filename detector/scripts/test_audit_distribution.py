"""Offline synthetic archives; no kernel, network, credentials or upstream code."""
import contextlib
import copy
import gzip
import hashlib
import io
import json
import pathlib
import stat
import tarfile
import tempfile
import unittest
from unittest import mock

import audit_distribution as audit


def tar_bytes(entries):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for name, value in entries:
            member = tarfile.TarInfo(name)
            if isinstance(value, bytes):
                member.size = len(value)
                archive.addfile(member, io.BytesIO(value))
            else:
                member.type = value[1]
                member.linkname = "../../outside"
                archive.addfile(member)
    return output.getvalue()


class DistributionAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.kernel = audit.read_json(audit.ROOT / "kernel-lock.json")
        self.lock = audit.read_json(audit.ROOT / "distribution-lock.json")

    def archive(self, entries, identifier="upstream-vendor"):
        payload = tar_bytes(entries)
        path = self.root / (identifier + ".tar.gz")
        path.write_bytes(payload)
        artifact = next(copy.deepcopy(item) for item in self.lock["artifacts"] if item["id"] == identifier)
        artifact["sha256"] = hashlib.sha256(payload).hexdigest()
        return artifact, path

    def sample(self):
        return [
            ("vendor/modules.txt", b"# example.org/a v1.2.3 => example.org/fork v1.3.0\n## explicit; go 1.20\nexample.org/a\n# example.org/a => example.org/fork v1.3.0\n"),
            ("vendor/example.org/a/LICENSE", b"complete fixture license\nline two\n"),
            ("vendor/example.org/a/NOTICE", b"fixture attribution\n"),
            ("vendor/example.org/a/code.go", b"package fixture\n"),
        ]

    def test_offline_report_and_require_ready(self):
        report, notices = audit.audit(self.lock, self.kernel, {})
        self.assertFalse(report["ready"])
        self.assertTrue(all(item["status"] == "missing" for item in report["artifacts"]))
        self.assertEqual(notices, {})
        for arguments, expected in (([], 0), (["--require-ready"], 2)):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(audit.main(arguments), expected)
            self.assertFalse(json.loads(output.getvalue())["ready"])

    def test_lock_cannot_assert_readiness(self):
        for key in ("ready", "verified", "provenanceVerified"):
            lock = copy.deepcopy(self.lock)
            lock[key] = True
            with self.assertRaisesRegex(audit.AuditError, "invalid_distribution_lock"):
                audit.audit(lock, self.kernel, {})

    def test_lock_binds_core_source_and_each_target(self):
        mutations = [
            lambda lock: lock["core"].update(sourceCommit="a" * 40),
            lambda lock: lock["artifacts"][0].update(sha256="f" * 64),
            lambda lock: lock["artifacts"].pop(0),
            lambda lock: lock["artifacts"].append(copy.deepcopy(lock["artifacts"][0])),
            lambda lock: lock["artifacts"][0].update(url="https://attacker.invalid/kernel.gz"),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                lock = copy.deepcopy(self.lock)
                mutate(lock)
                with self.assertRaises(audit.AuditError):
                    audit.audit(lock, self.kernel, {})

    def test_unknown_and_repeated_artifact_rejected(self):
        with self.assertRaisesRegex(audit.AuditError, "unknown_artifact_id"):
            audit.audit(self.lock, self.kernel, {"unknown": "file"})
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(audit.main(["--artifact", "upstream-vendor=x", "--artifact", "upstream-vendor=y"]), 1)

    def test_duplicate_json_key_rejected(self):
        path = self.root / "lock.json"
        path.write_text('{"ready":false,"ready":true}')
        with self.assertRaisesRegex(audit.AuditError, "duplicate_json_key"):
            audit.read_json(path)

    def test_real_bytes_and_replacements_inventory(self):
        artifact, path = self.archive(self.sample())
        report, notices = audit.audit_artifact(artifact, path)
        self.assertEqual(report["status"], "verified")
        self.assertEqual(report["verifiedScope"], "sha256-and-structure")
        self.assertEqual(report["noticeCoverage"], "unverified")
        self.assertEqual(report["modules"][0]["replacement"], {"module": "example.org/fork", "version": "v1.3.0"})
        self.assertEqual(len(report["modules"][0]["noticePaths"]), 2)
        self.assertEqual(notices["vendor/example.org/a/LICENSE"], self.sample()[1][1])
        self.assertEqual(report["inventory"][1]["sha256"], hashlib.sha256(self.sample()[1][1]).hexdigest())

    def test_notice_collection_preserves_full_text_and_hash_binding(self):
        artifact, path = self.archive(self.sample())
        self.lock["artifacts"] = [artifact if item["id"] == artifact["id"] else item for item in self.lock["artifacts"]]
        report, notices = audit.audit(self.lock, self.kernel, {artifact["id"]: path})
        target = self.root / "collected"
        result = audit.collect_notices(target, report, notices)
        self.assertEqual(result, {"files": 2, "coverage": "unverified"})
        inventory = json.loads((target / "inventory.json").read_text())
        self.assertFalse(inventory["ready"])
        self.assertEqual(inventory["artifacts"], [{"id": artifact["id"], "sha256": artifact["sha256"], "lockedSource": artifact["url"], "role": artifact["role"]}])
        self.assertEqual(inventory["core"], self.lock["core"])
        for entry in inventory["files"]:
            content = (target / entry["path"]).read_bytes()
            self.assertEqual(hashlib.sha256(content).hexdigest(), entry["sha256"])
            self.assertEqual(content, notices[entry["artifactId"]][entry["sourcePath"]])
        with self.assertRaises(FileExistsError):
            audit.collect_notices(target, report, notices)

    def test_collection_does_not_create_empty_placeholder(self):
        report, notices = audit.audit(self.lock, self.kernel, {})
        destination = self.root / "empty"
        with self.assertRaisesRegex(audit.AuditError, "no_notices_to_collect"):
            audit.collect_notices(destination, report, notices)
        self.assertFalse(destination.exists())

    def test_checksum_and_corruption_rejected(self):
        artifact, path = self.archive(self.sample())
        path.write_bytes(path.read_bytes() + b"tamper")
        with self.assertRaisesRegex(audit.AuditError, "checksum_mismatch"):
            audit.audit_artifact(artifact, path)
        artifact["sha256"] = hashlib.sha256(path.read_bytes()).hexdigest()
        self.lock["artifacts"] = [artifact if item["id"] == artifact["id"] else item for item in self.lock["artifacts"]]
        report, notices = audit.audit(self.lock, self.kernel, {artifact["id"]: path})
        self.assertEqual(next(item for item in report["artifacts"] if item["id"] == artifact["id"])["status"], "invalid")
        with self.assertRaisesRegex(audit.AuditError, "invalid_artifact_blocks_collection"):
            audit.collect_notices(self.root / "invalid", report, notices)

    def test_source_rewrite_between_hash_and_parse_cannot_change_snapshot(self):
        entries = self.sample()
        artifact, path = self.archive(entries)
        replacement = tar_bytes([(name, b"replacement notice" if name.endswith("NOTICE") else data) for name, data in entries])
        original_gzip = audit.gzip.GzipFile

        def rewrite_then_parse(*args, **kwargs):
            # A real second descriptor overwrites the input after hashing.
            with path.open("wb") as other_descriptor:
                other_descriptor.write(replacement)
            return original_gzip(*args, **kwargs)

        with mock.patch.object(audit.gzip, "GzipFile", side_effect=rewrite_then_parse):
            result, notices = audit.audit_artifact(artifact, path)
        self.assertEqual(path.read_bytes(), replacement)
        self.assertEqual(result["sha256"], artifact["sha256"])
        self.assertEqual(notices["vendor/example.org/a/NOTICE"], b"fixture attribution\n")

    def test_open_descriptor_must_be_regular_file(self):
        artifact, path = self.archive(self.sample())
        with mock.patch.object(audit.os, "fstat", return_value=mock.Mock(st_mode=stat.S_IFIFO)):
            with self.assertRaisesRegex(audit.AuditError, "artifact_not_regular_file"):
                audit.audit_artifact(artifact, path)

    def test_unsafe_paths_rejected(self):
        names = ["../out", "/out", "C:/out", "vendor\\out", "vendor/../out", "vendor//out", "vendor/./out", "vendor/NUL.txt", "vendor/space ", "vendor/file.", "vendor/\x01x", "vendor/" + "x/" * 33 + "out"]
        for name in names:
            with self.subTest(name=name):
                artifact, path = self.archive([(name, b"bad")])
                with self.assertRaises(audit.AuditError):
                    audit.audit_artifact(artifact, path)

    def test_links_devices_and_fifo_rejected(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE):
            with self.subTest(kind=kind):
                artifact, path = self.archive([("vendor/link", ("type", kind))])
                with self.assertRaisesRegex(audit.AuditError, "unsafe_archive_member_type"):
                    audit.audit_artifact(artifact, path)

    def test_duplicate_and_portability_collisions_rejected(self):
        for first, second in (("vendor/LICENSE", "vendor/LICENSE"), ("vendor/LICENSE", "./vendor/LICENSE"), ("vendor/LICENSE", "vendor/license"), ("vendor/caf\u00e9", "vendor/cafe\u0301")):
            with self.subTest(first=first, second=second):
                artifact, path = self.archive([(first, b"one"), (second, b"two")])
                with self.assertRaisesRegex(audit.AuditError, "duplicate_archive_path"):
                    audit.audit_artifact(artifact, path)

    def test_file_parent_conflicts_rejected_in_both_orders(self):
        entries = [("vendor/a", b"file"), ("vendor/a/b", b"child")]
        for order in (entries, entries[::-1]):
            artifact, path = self.archive(order)
            with self.assertRaisesRegex(audit.AuditError, "archive_path_type_conflict"):
                audit.audit_artifact(artifact, path)

    def test_resource_limits(self):
        artifact, path = self.archive(self.sample())
        for key, maximum, error in (("compressedBytes", 1, "compressed_size_limit"), ("expandedBytes", 512, "expanded_size_limit"), ("memberBytes", 1, "archive_member_size_limit"), ("members", 1, "archive_member_limit"), ("noticeBytes", 1, "notice_size_limit"), ("totalNoticeBytes", 1, "notice_size_limit"), ("metadataBytes", 1, "metadata_size_limit")):
            with self.subTest(key=key):
                limits = {**audit.LIMITS, key: maximum}
                with self.assertRaisesRegex(audit.AuditError, error):
                    audit.audit_artifact(artifact, path, limits)

    def test_wrong_prefix_and_missing_required_data(self):
        artifact, path = self.archive([("other/NOTICE", b"text")])
        with self.assertRaisesRegex(audit.AuditError, "archive_prefix_mismatch"):
            audit.audit_artifact(artifact, path)
        artifact, path = self.archive([("vendor/NOTICE", b"text")])
        result, _ = audit.audit_artifact(artifact, path)
        self.assertEqual(result["status"], "unverified")
        self.assertEqual(result["missingRequiredFiles"], ["vendor/modules.txt"])

    def test_empty_ca_is_blocker(self):
        template = next(item for item in self.lock["artifacts"] if item["id"] == "historical-core-source")
        entries = [("mihomo-source/" + name, b"# example.org/a v1.0.0\n" if name == "vendor/modules.txt" else b"fixture") for name in template["requiredFiles"]]
        entries = [(name, b"" if name.endswith("ca-certificates.crt") else data) for name, data in entries]
        artifact, path = self.archive(entries, "historical-core-source")
        result, _ = audit.audit_artifact(artifact, path)
        self.assertEqual(result["status"], "unverified")
        self.assertEqual(result["missingRequiredFiles"], ["mihomo-source/component/ca/ca-certificates.crt"])

    def test_all_material_hashes_pass_still_cannot_assert_provenance(self):
        supplied = {}
        for artifact in self.lock["artifacts"]:
            if artifact["role"] == "kernel":
                data = gzip.compress(b"synthetic non-executable bytes")
                self.kernel["assets"][artifact["target"]]["sha256"] = hashlib.sha256(data).hexdigest()
            else:
                entries = [(artifact["prefix"] + "/" + name, b"# example.org/a v1.0.0\n" if name.endswith("modules.txt") else b"fixture") for name in artifact["requiredFiles"]]
                data = tar_bytes(entries)
            path = self.root / artifact["id"]
            path.write_bytes(data)
            artifact["sha256"] = hashlib.sha256(data).hexdigest()
            supplied[artifact["id"]] = path
        report, _ = audit.audit(self.lock, self.kernel, supplied)
        self.assertTrue(all(item["status"] == "verified" for item in report["artifacts"]))
        self.assertFalse(report["ready"])
        self.assertIn("provenance-verifier", {item["id"] for item in report["blockers"]})
        self.assertIn("corresponding-source-verifier", {item["id"] for item in report["blockers"]})

    def test_truncated_gzip_and_hidden_second_archive_rejected(self):
        for data in (tar_bytes(self.sample())[:-4], tar_bytes(self.sample()) + tar_bytes(self.sample())):
            artifact, path = self.archive(self.sample())
            path.write_bytes(data)
            artifact["sha256"] = hashlib.sha256(data).hexdigest()
            with self.assertRaises((audit.AuditError, EOFError)):
                audit.audit_artifact(artifact, path)

    def test_pax_paths_and_oversized_metadata_rejected(self):
        for attributes, error in (({"path": "../../outside"}, "unsafe_archive_path"), ({"comment": "x" * (audit.LIMITS["metadataBytes"] + 1)}, "archive_metadata_size_limit")):
            output = io.BytesIO()
            with tarfile.open(fileobj=output, mode="w:gz", format=tarfile.PAX_FORMAT) as archive:
                member = tarfile.TarInfo("vendor/NOTICE")
                member.pax_headers = attributes
                member.size = 1
                archive.addfile(member, io.BytesIO(b"x"))
            artifact, path = self.archive(self.sample())
            path.write_bytes(output.getvalue())
            artifact["sha256"] = hashlib.sha256(output.getvalue()).hexdigest()
            with self.assertRaisesRegex(audit.AuditError, error):
                audit.audit_artifact(artifact, path)

    def test_module_inventory_is_bounded(self):
        modules = "\n".join(f"# example.org/module{i} v1.0.0" for i in range(audit.LIMITS["modules"] + 1))
        with self.assertRaisesRegex(audit.AuditError, "vendor_module_limit"):
            audit.module_inventory(modules)

    def test_global_and_many_field_pax_headers_rejected(self):
        for global_headers in (True, False):
            output = io.BytesIO()
            attributes = {"field" + str(i): "value" for i in range(65)}
            with tarfile.open(fileobj=output, mode="w:gz", format=tarfile.PAX_FORMAT, pax_headers=attributes if global_headers else None) as archive:
                member = tarfile.TarInfo("vendor/NOTICE")
                if not global_headers:
                    member.pax_headers = attributes
                archive.addfile(member, io.BytesIO())
            artifact, path = self.archive(self.sample())
            path.write_bytes(output.getvalue())
            artifact["sha256"] = hashlib.sha256(output.getvalue()).hexdigest()
            expected = "global_pax_header_unsupported" if global_headers else "archive_metadata_field_limit"
            with self.assertRaisesRegex(audit.AuditError, expected):
                audit.audit_artifact(artifact, path)

    def test_invalid_lock_input_is_structured_and_closed(self):
        path = self.root / "bad.json"
        for data in ('{"schemaVersion": true}', 'null', '{"schemaVersion": 1, "core": []}', '{'):
            path.write_text(data)
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(audit.main(["--lock", str(path), "--require-ready"]), 1)
            self.assertFalse(json.loads(output.getvalue())["ready"])


if __name__ == "__main__":
    unittest.main()
