"""Offline synthetic archives; no kernel, network, credentials or upstream code."""
import contextlib
import copy
import gzip
import hashlib
import io
import json
import pathlib
import stat
import struct
import tarfile
import tempfile
import unittest
import warnings
import zipfile
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


def zip_bytes(entries, compression=zipfile.ZIP_DEFLATED, descriptor=False):
    class Stream(io.BytesIO):
        def seek(self, *args):
            raise io.UnsupportedOperation("synthetic streaming ZIP")
    output = Stream() if descriptor else io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)
        with zipfile.ZipFile(output, "w", compression=compression) as archive:
            for name, data in entries:
                archive.writestr(name, data)
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

    def zip_archive(self, entries=None, compression=zipfile.ZIP_DEFLATED, descriptor=False):
        artifact = next(copy.deepcopy(item) for item in self.lock["artifacts"] if item["id"] == "kernel-windows-amd64")
        executable = b"synthetic non-executable Windows fixture bytes"
        entries = [(artifact["entry"], executable)] if entries is None else entries
        payload = zip_bytes(entries, compression, descriptor)
        path = self.root / "kernel.zip"
        path.write_bytes(payload)
        artifact.update(sha256=hashlib.sha256(payload).hexdigest(), executableSha256=hashlib.sha256(executable).hexdigest(), executableBytes=len(executable))
        return artifact, path

    def replace_zip(self, artifact, path, payload):
        path.write_bytes(payload)
        artifact["sha256"] = hashlib.sha256(payload).hexdigest()

    def hidden_zip64_archive(self, extra_records=0):
        artifact, path = self.zip_archive(compression=zipfile.ZIP_STORED)
        payload = path.read_bytes()
        end = payload.rfind(b"PK\x05\x06")
        directory_offset = struct.unpack_from("<I", payload, end + 16)[0]
        if extra_records:
            executable = payload[directory_offset:end] * extra_records
            payload = zip_bytes([(artifact["entry"], executable)], zipfile.ZIP_STORED)
            artifact.update(executableBytes=len(executable), executableSha256=hashlib.sha256(executable).hexdigest())
            end = payload.rfind(b"PK\x05\x06")
            directory_offset = struct.unpack_from("<I", payload, end + 16)[0]
        directory = bytearray(payload[directory_offset:end])
        struct.pack_into("<H", directory, 32, 76)
        record_offset = directory_offset + len(directory)
        alternate_offset = 30 + len(artifact["entry"].encode("ascii")) if extra_records else directory_offset
        record = struct.pack("<4sQ2H2I4Q", b"PK\x06\x06", 44, 20, 20, 0, 0, extra_records + 1, extra_records + 1, record_offset - alternate_offset, alternate_offset)
        locator = struct.pack("<4sIQI", b"PK\x06\x07", 0, record_offset, 1)
        ordinary_end = bytearray(payload[end:])
        struct.pack_into("<I", ordinary_end, 12, len(directory) + 76)
        payload = payload[:directory_offset] + directory + record + locator + ordinary_end
        self.replace_zip(artifact, path, payload)
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
                if artifact["format"] == "zip":
                    fixture, path = self.zip_archive()
                    artifact.update(fixture)
                    data = path.read_bytes()
                    for key in ("entry", "executableBytes", "executableSha256"):
                        self.kernel["assets"][artifact["target"]][key] = artifact[key]
                else:
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

    def test_windows_lock_binds_archive_and_executable_metadata(self):
        mutations = [
            ("entry", "other.exe"), ("entry", "../mihomo.exe"),
            ("executableSha256", "a" * 64), ("executableSha256", "bad"),
            ("executableBytes", 1), ("executableBytes", True),
            ("executableBytes", audit.LIMITS["memberBytes"] + 1),
            ("format", "gzip"), ("prefix", "folder"), ("requiredFiles", ["a"]),
        ]
        for key, value in mutations:
            with self.subTest(key=key, value=value):
                lock = copy.deepcopy(self.lock)
                entry = next(item for item in lock["artifacts"] if item["target"] == "windows-amd64")
                entry[key] = value
                with self.assertRaises(audit.AuditError):
                    audit.validate_lock(lock, self.kernel)
        kernel = copy.deepcopy(self.kernel)
        del kernel["assets"]["windows-amd64"]
        with self.assertRaisesRegex(audit.AuditError, "invalid_kernel_targets"):
            audit.validate_lock(self.lock, kernel)

    def test_windows_zip_hash_size_inventory_and_stream_descriptors(self):
        for method in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            for descriptor in (False, True):
                with self.subTest(method=method, descriptor=descriptor):
                    artifact, path = self.zip_archive(compression=method, descriptor=descriptor)
                    result, notices = audit.audit_artifact(artifact, path)
                    self.assertEqual(result["status"], "verified")
                    self.assertEqual(result["verifiedScope"], "sha256-and-structure")
                    self.assertEqual(result["executableIdentity"], "locked-sha256")
                    self.assertEqual(result["expandedBytes"], artifact["executableBytes"])
                    self.assertEqual(result["uncompressedSha256"], artifact["executableSha256"])
                    self.assertEqual(result["inventory"][0]["path"], artifact["entry"])
                    self.assertEqual(notices, {})

    def test_windows_zip_unsafe_names_and_extra_members(self):
        names = ["../out.exe", "/out.exe", "C:/out.exe", "folder\\out.exe", "folder/out.exe", "./mihomo-windows-amd64-compatible.exe", "NUL.exe", "mihomo.exe\x00hidden", "mihomo.exe "]
        for name in names:
            with self.subTest(name=name):
                artifact, path = self.zip_archive([(name, b"x")])
                with self.assertRaises(audit.AuditError):
                    audit.audit_artifact(artifact, path)
        for names in (["same.exe", "same.exe"], ["A.exe", "a.exe"], []):
            artifact, path = self.zip_archive([(name, b"x") for name in names])
            with self.assertRaisesRegex(audit.AuditError, "zip_requires_one_executable"):
                audit.audit_artifact(artifact, path)

    def test_windows_zip_types_encryption_and_unsupported_compression(self):
        for kind in (stat.S_IFDIR, stat.S_IFLNK, stat.S_IFCHR, stat.S_IFBLK, stat.S_IFIFO, stat.S_IFSOCK):
            info = zipfile.ZipInfo("mihomo-windows-amd64-compatible.exe")
            info.external_attr = (kind | 0o600) << 16
            artifact, path = self.zip_archive([(info, b"x")])
            with self.assertRaisesRegex(audit.AuditError, "unsafe_archive_member_type"):
                audit.audit_artifact(artifact, path)
        for flag in (1, 0x40, 0x2000):
            artifact, path = self.zip_archive()
            data = bytearray(path.read_bytes())
            central = data.index(b"PK\x01\x02")
            struct.pack_into("<H", data, 6, flag)
            struct.pack_into("<H", data, central + 8, flag)
            self.replace_zip(artifact, path, data)
            with self.assertRaisesRegex(audit.AuditError, "unsupported_zip_encoding"):
                audit.audit_artifact(artifact, path)
        artifact, path = self.zip_archive(compression=zipfile.ZIP_BZIP2)
        with self.assertRaises(audit.AuditError):
            audit.audit_artifact(artifact, path)

    def test_windows_zip_resource_limits_and_locked_inner_digest(self):
        artifact, path = self.zip_archive()
        for key, value in (("compressedBytes", 1), ("memberBytes", 1), ("expandedBytes", 1), ("members", 0), ("metadataBytes", 1)):
            with self.subTest(limit=key):
                with self.assertRaises(audit.AuditError):
                    audit.audit_artifact(artifact, path, {**audit.LIMITS, key: value})
        for key, value, error in (("executableBytes", 1, "kernel_executable_size_mismatch"), ("executableSha256", "f" * 64, "kernel_executable_checksum_mismatch")):
            modified = {**artifact, key: value}
            with self.assertRaisesRegex(audit.AuditError, error):
                audit.audit_artifact(modified, path)

    def test_windows_zip_crc_and_header_mismatch(self):
        for change, error in (("crc", "zip_crc_mismatch"), ("local-name", "zip_local_header_mismatch"), ("local-size", "zip_local_header_mismatch"), ("local-flags", "zip_local_header_mismatch"), ("overlap", "zip_overlapping_member")):
            artifact, path = self.zip_archive()
            data = bytearray(path.read_bytes())
            central = data.index(b"PK\x01\x02")
            if change == "crc":
                struct.pack_into("<I", data, 14, 123)
                struct.pack_into("<I", data, central + 16, 123)
            elif change == "local-name":
                data[30] = ord("z")
            elif change == "local-size":
                struct.pack_into("<I", data, 22, 1)
            elif change == "local-flags":
                struct.pack_into("<H", data, 6, 8)
            else:
                struct.pack_into("<I", data, 18, len(data))
                struct.pack_into("<I", data, central + 20, len(data))
            self.replace_zip(artifact, path, data)
            with self.subTest(change=change):
                with self.assertRaisesRegex(audit.AuditError, error):
                    audit.audit_artifact(artifact, path)

    def test_windows_zip_preflight_and_truncated_or_concatenated_archives(self):
        for change in ("truncated", "suffix", "concatenated", "prefix", "many-count", "multi-disk", "zip64", "high-version"):
            artifact, path = self.zip_archive()
            data = bytearray(path.read_bytes())
            end = data.rfind(b"PK\x05\x06")
            central = data.index(b"PK\x01\x02")
            if change == "truncated":
                data = data[:-1]
            elif change == "suffix":
                data += b"hidden data"
            elif change == "concatenated":
                data += bytes(data)
            elif change == "prefix":
                data = b"hidden prefix" + data
            elif change == "many-count":
                struct.pack_into("<HH", data, end + 8, 30000, 30000)
            elif change == "multi-disk":
                struct.pack_into("<H", data, end + 4, 1)
            elif change == "zip64":
                struct.pack_into("<I", data, end + 12, 0xffffffff)
            else:
                struct.pack_into("<H", data, central + 6, 100)
            self.replace_zip(artifact, path, data)
            with self.subTest(change=change), mock.patch.object(audit.zipfile, "ZipFile", side_effect=AssertionError("preflight must reject before directory allocation")):
                with self.assertRaises(audit.AuditError):
                    audit.audit_artifact(artifact, path)

    def test_windows_zip_descriptor_and_extra_metadata(self):
        artifact, path = self.zip_archive(descriptor=True)
        data = bytearray(path.read_bytes())
        descriptor = data.index(b"PK\x07\x08")
        data[descriptor + 4] ^= 1
        self.replace_zip(artifact, path, data)
        with self.assertRaisesRegex(audit.AuditError, "invalid_zip_descriptor"):
            audit.audit_artifact(artifact, path)
        for extra in (b"\x01\x00\x00\x00", b"\x75\x70\x00\x00", b"\x01\x99\x00\x00", b"\x55\x54\x00\x00" * 2, b"\x55\x54\x08\x00x"):
            info = zipfile.ZipInfo("mihomo-windows-amd64-compatible.exe")
            info.extra = extra
            artifact, path = self.zip_archive([(info, b"x")])
            with self.assertRaises(audit.AuditError):
                audit.audit_artifact(artifact, path)

    def test_windows_zip64_locator_hidden_in_entry_comment_rejected(self):
        artifact, path = self.hidden_zip64_archive()
        # This is a readable single-member archive to the standard library;
        # ordinary count/version checks alone do not reject its hidden ZIP64.
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(len(archive.infolist()), 1)
            self.assertEqual(archive.read(artifact["entry"]), b"synthetic non-executable Windows fixture bytes")
        with mock.patch.object(audit.zipfile, "ZipFile", side_effect=AssertionError("ZIP64 must be rejected before directory allocation")):
            with self.assertRaisesRegex(audit.AuditError, "unsupported_zip64_locator"):
                audit.audit_artifact(artifact, path)

    def test_windows_hidden_zip64_cannot_override_directory_allocation_budget(self):
        artifact, path = self.hidden_zip64_archive(extra_records=1000)
        payload = path.read_bytes()
        end = payload.rfind(b"PK\x05\x06")
        self.assertEqual(struct.unpack_from("<HH", payload, end + 8), (1, 1))
        self.assertLess(struct.unpack_from("<I", payload, end + 12)[0], 1024)
        # The alternate directory starts inside the stored executable and is
        # selected by ZipFile despite the ordinary EOCD advertising one entry.
        with zipfile.ZipFile(path) as archive:
            self.assertEqual(len(archive.infolist()), 1001)
        with mock.patch.object(audit.zipfile, "ZipFile", side_effect=AssertionError("preflight must prevent alternate-directory allocation")):
            with self.assertRaisesRegex(audit.AuditError, "unsupported_zip64_locator"):
                audit.audit_artifact(artifact, path, {**audit.LIMITS, "members": 1, "metadataBytes": 1024})

    def test_windows_zip_trailing_compressed_bytes_rejected(self):
        artifact, path = self.zip_archive()
        data = bytearray(path.read_bytes())
        central = data.index(b"PK\x01\x02")
        compressed = struct.unpack_from("<I", data, 18)[0]
        data[central:central] = b"trailer"
        central += 7
        end = data.rfind(b"PK\x05\x06")
        struct.pack_into("<I", data, 18, compressed + 7)
        struct.pack_into("<I", data, central + 20, compressed + 7)
        struct.pack_into("<I", data, end + 16, central)
        self.replace_zip(artifact, path, data)
        with self.assertRaisesRegex(audit.AuditError, "trailing_zip_compressed_data"):
            audit.audit_artifact(artifact, path)

    def test_windows_zip_expansion_beyond_declared_size_and_truncated_deflate(self):
        for change, error in (("size", "kernel_executable_size_mismatch"), ("truncated", "truncated_zip_member")):
            artifact, path = self.zip_archive()
            data = bytearray(path.read_bytes())
            central = data.index(b"PK\x01\x02")
            if change == "size":
                artifact["executableBytes"] = 1
                struct.pack_into("<I", data, 22, 1)
                struct.pack_into("<I", data, central + 24, 1)
            else:
                compressed = struct.unpack_from("<I", data, 18)[0]
                del data[central - 1]
                central -= 1
                end = data.rfind(b"PK\x05\x06")
                struct.pack_into("<I", data, 18, compressed - 1)
                struct.pack_into("<I", data, central + 20, compressed - 1)
                struct.pack_into("<I", data, end + 16, central)
            self.replace_zip(artifact, path, data)
            with self.subTest(change=change), self.assertRaisesRegex(audit.AuditError, error):
                audit.audit_artifact(artifact, path)

    def test_windows_invalid_archive_is_structured_and_blocks_collection(self):
        artifact, path = self.zip_archive()
        self.replace_zip(artifact, path, path.read_bytes()[:-5])
        self.lock["artifacts"] = [artifact if item["id"] == artifact["id"] else item for item in self.lock["artifacts"]]
        self.kernel["assets"]["windows-amd64"].update({key: artifact[key] for key in ("sha256", "entry", "executableSha256", "executableBytes")})
        report, notices = audit.audit(self.lock, self.kernel, {artifact["id"]: path})
        result = next(item for item in report["artifacts"] if item["id"] == artifact["id"])
        self.assertEqual(result["status"], "invalid")
        self.assertFalse(report["ready"])
        destination = self.root / "no-collection"
        with self.assertRaisesRegex(audit.AuditError, "invalid_artifact_blocks_collection"):
            audit.collect_notices(destination, report, notices)
        self.assertFalse(destination.exists())


if __name__ == "__main__":
    unittest.main()
