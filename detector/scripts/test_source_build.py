import gzip
import hashlib
import io
import json
import os
import pathlib
import stat
import tarfile
import tempfile
import unittest
import zipfile
from unittest import mock

import source_build as build


def archive(entries, prefix="source", global_headers=None):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT, pax_headers=global_headers) as stream:
        for name, data, mode in entries:
            item = tarfile.TarInfo(prefix + "/" + name)
            item.size, item.mode = len(data), mode
            stream.addfile(item, io.BytesIO(data))
    return gzip.compress(raw.getvalue(), mtime=0)


class SourceBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self):
        lock = build.load_lock(build.ROOT / "source-build-lock.json")
        source = [("component/ca/ca-certificates.crt", b"", 0o644), ("LICENSE", b"fixture full license text\n", 0o644),
                  ("go.mod", b"module fixture\n\ngo 1.20\n", 0o644), ("main.go", b"package main\nfunc main() {}\n", 0o644)]
        vendor = [("modules.txt", b"# example.com/dependency v1.0.0\n## explicit\nexample.com/dependency\n", 0o644),
                  ("example.com/dependency/LICENSE", b"fixture dependency license\n", 0o644),
                  ("example.com/dependency/main.go", b"package dependency\n", 0o644)]
        tool = [("VERSION", b"go1.27.2\ntime fixture\n", 0o644), ("LICENSE", b"fixture toolchain license\n", 0o644),
                ("src/runtime/proc.go", b"package runtime\n", 0o644), ("bin/go", b"fixture not executable code\n", 0o755)]
        lock["source"]["prefix"] = "source"
        lock["source"]["tree"] = build.git_tree(source)
        lock["replacements"] = []
        materials = []
        for name, files, prefix, entry in (("source", source, "source", lock["source"]), ("vendor", vendor, "vendor", lock["vendor"]), ("tool", tool, "go", lock["toolchain"]["hosts"]["linux-amd64"])):
            payload = archive(files, prefix)
            entry["sha256"] = build.digest(payload)
            path = self.root / (name + ".tar.gz")
            path.write_bytes(payload)
            materials.append(path)
        return lock, materials

    def prepared(self):
        lock, materials = self.fixture()
        work = self.root / "work"
        build.prepare(lock, *materials, work, "linux-amd64")
        return lock, work

    def test_empty_git_tree_identity(self):
        self.assertEqual(build.git_tree([]), "4b825dc642cb6eb9a060e54bf8d69288fbee4904")

    def test_lock_locations_must_match_fixed_repository_and_version(self):
        original = build.load_lock(build.ROOT / "source-build-lock.json")
        for section, key, value, error in (
            ("source", "url", original["source"]["url"] + "?redirect=other", "invalid_source_location"),
            ("source", "repository", "other/mihomo", "invalid_source_location"),
            ("source", "prefix", "mihomo-other", "invalid_source_location"),
            ("vendor", "url", "https://example.com/vendor.tar.gz", "invalid_vendor_location"),
        ):
            with self.subTest(section=section, key=key):
                lock = json.loads(json.dumps(original))
                lock[section][key] = value
                path = self.root / "location-lock.json"
                path.write_bytes(build.json_bytes(lock))
                with self.assertRaisesRegex(build.BuildError, error):
                    build.load_lock(path)

    def test_lock_toolchain_filename_cannot_escape_or_change_host(self):
        for filename in ("../go.zip", "go1.27.2.linux-amd64.tar.gz", "go1.27.2.windows-amd64.zip?token=x"):
            with self.subTest(filename=filename):
                lock = build.load_lock(build.ROOT / "source-build-lock.json")
                lock["toolchain"]["hosts"]["windows-amd64"]["file"] = filename
                path = self.root / "toolchain-lock.json"
                path.write_bytes(build.json_bytes(lock))
                with self.assertRaisesRegex(build.BuildError, "invalid_toolchain_location"):
                    build.load_lock(path)

    def test_git_tree_modes_and_order_are_bound(self):
        files = [("z", b"one", 0o644), ("a/b", b"two", 0o755)]
        self.assertEqual(build.git_tree(files), build.git_tree(list(reversed(files))))
        self.assertNotEqual(build.git_tree(files), build.git_tree([(p, d, 0o644) for p, d, m in files]))

    def test_prepare_revalidates_exact_materials(self):
        lock, work = self.prepared()
        state = build.load_prepared(work, lock)
        self.assertFalse(state["releaseReady"])
        self.assertEqual(state["authenticatedProvenance"], "missing")
        self.assertEqual(len(state["sourceFiles"]), 7)

    def test_wrong_archive_digest_creates_no_workspace(self):
        lock, files = self.fixture()
        files[0].write_bytes(files[0].read_bytes() + b"changed")
        with self.assertRaisesRegex(build.BuildError, "material_checksum_mismatch"):
            build.prepare(lock, *files, self.root / "work", "linux-amd64")
        self.assertFalse((self.root / "work").exists())

    def test_source_tree_mismatch_rejected(self):
        lock, files = self.fixture()
        lock["source"]["tree"] = "0" * 40
        with self.assertRaisesRegex(build.BuildError, "source_git_tree_mismatch"):
            build.prepare(lock, *files, self.root / "work", "linux-amd64")

    def test_populated_ca_rejected_even_with_matching_source_tree(self):
        lock, files = self.fixture()
        entries = [("component/ca/ca-certificates.crt", b"unreviewed CA", 0o644)]
        files[0].write_bytes(archive(entries))
        lock["source"]["sha256"] = build.digest(files[0].read_bytes())
        lock["source"]["tree"] = build.git_tree(entries)
        with self.assertRaisesRegex(build.BuildError, "source_system_ca_input_mismatch"):
            build.prepare(lock, *files, self.root / "work", "linux-amd64")

    def test_prepared_report_cannot_bless_modified_source(self):
        lock, work = self.prepared()
        path = work / "source/main.go"
        path.write_bytes(b"changed source")
        state = build.read_json(work / "prepared.json")
        entry = next(item for item in state["sourceFiles"] if item["path"] == "main.go")
        entry.update(sha256=build.digest(path.read_bytes()), bytes=path.stat().st_size)
        (work / "prepared.json").write_bytes(build.json_bytes(state))
        with self.assertRaisesRegex(build.BuildError, "prepared_inventory_mismatch"):
            build.load_prepared(work, lock)

    def test_prepared_archive_cannot_be_replaced(self):
        lock, work = self.prepared()
        (work / "materials/vendor.archive").write_bytes(b"other vendor")
        with self.assertRaisesRegex(build.BuildError, "material_checksum_mismatch"):
            build.load_prepared(work, lock)

    def test_extra_input_file_rejected(self):
        lock, work = self.prepared()
        (work / "source/injected.go").write_text("package main")
        with self.assertRaisesRegex(build.BuildError, "prepared_tree_file_set_changed"):
            build.load_prepared(work, lock)

    def test_vendor_replacement_mismatch_rejected(self):
        lock, files = self.fixture()
        lock["replacements"] = [{"module": "fake", "replacement": {"module": "elsewhere"}, "version": "v1"}]
        with self.assertRaisesRegex(build.BuildError, "vendor_replacement_mismatch"):
            build.prepare(lock, *files, self.root / "work", "linux-amd64")

    def test_archive_traversal_and_case_collision_rejected(self):
        for entries in ([("../outside", b"x", 0o644)], [("Name", b"x", 0o644), ("name", b"y", 0o644)]):
            with self.subTest(entries=entries), self.assertRaises((build.BuildError, build.audit.AuditError)):
                list(build.archive_files(archive(entries), "source", "tar.gz"))

    def test_symlink_member_rejected(self):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode="w") as stream:
            item = tarfile.TarInfo("source/link")
            item.type, item.linkname = tarfile.SYMTYPE, "../outside"
            stream.addfile(item)
        with self.assertRaisesRegex(build.BuildError, "archive_special_file"):
            list(build.archive_files(gzip.compress(raw.getvalue()), "source", "tar.gz"))

    def test_global_pax_only_accepts_matching_commit_comment(self):
        entries = [("main.go", b"source", 0o644)]
        payload = archive(entries, global_headers={"comment": "a" * 40})
        self.assertEqual(list(build.archive_files(payload, "source", "tar.gz", "a" * 40)), entries)
        with self.assertRaisesRegex(build.BuildError, "source_commit_comment_mismatch"):
            list(build.archive_files(payload, "source", "tar.gz", "b" * 40))
        with self.assertRaisesRegex(build.BuildError, "unsupported_global_pax"):
            list(build.archive_files(archive(entries, global_headers={"path": "outside"}), "source", "tar.gz"))

    def test_zip_traversal_and_nonregular_rejected(self):
        for name, mode in (("go/../outside", 0o644), ("go/link", stat.S_IFLNK | 0o777)):
            output = io.BytesIO()
            with zipfile.ZipFile(output, "w") as stream:
                entry = zipfile.ZipInfo(name)
                entry.external_attr = mode << 16
                stream.writestr(entry, b"fixture")
            with self.subTest(name=name), self.assertRaises((build.BuildError, build.audit.AuditError)):
                list(build.archive_files(output.getvalue(), "go", "zip"))

    def test_archive_member_limit(self):
        with mock.patch.object(build, "MAX_MEMBERS", 1), self.assertRaisesRegex(build.BuildError, "archive_resource_limit"):
            list(build.archive_files(archive([("a", b"1", 0o644), ("b", b"2", 0o644)]), "source", "tar.gz"))

    def test_build_environment_blocks_inherited_go_configuration(self):
        with mock.patch.dict(os.environ, {"GOFLAGS": "-overlay=evil", "GOTOOLCHAIN": "auto", "GOEXPERIMENT": "custom", "GOWORK": "evil", "GOPROXY": "https://example.invalid", "HTTP_PROXY": "http://secret"}):
            env = build.build_environment(self.root, "linux-amd64")
        self.assertEqual(env["GOFLAGS"], "")
        self.assertEqual(env["GOPROXY"], "off")
        self.assertEqual(env["GOTOOLCHAIN"], "local")
        self.assertEqual(env["GOWORK"], "off")
        self.assertNotIn("HTTP_PROXY", env)

    def test_dependency_path_cannot_escape_inputs(self):
        lock, work = self.prepared()
        state = build.load_prepared(work, lock)
        with self.assertRaisesRegex(build.BuildError, "dependency_outside_prepared_inputs"):
            build.dependency_evidence([{"Dir": str(self.root), "GoFiles": ["outside.go"]}], work, state)

    def test_source_pack_preserves_full_source_and_notices_without_readiness_claim(self):
        lock, work = self.prepared()
        first = build.package_materials(lock, work, self.root / "pack1")
        second = build.package_materials(lock, work, self.root / "pack2")
        self.assertEqual(first["archive"]["sha256"], second["archive"]["sha256"])
        self.assertFalse(first["releaseReady"])
        self.assertEqual(first["noticeCoverage"], "requires-review")
        with tarfile.open(self.root / "pack1" / first["archive"]["file"], "r:gz") as stream:
            manifest = json.load(stream.extractfile("manifest.json"))
            for record in manifest["files"]:
                content = stream.extractfile(record["path"]).read()
                self.assertEqual(hashlib.sha256(content).hexdigest(), record["sha256"])
            self.assertEqual(stream.extractfile("mihomo/vendor/example.com/dependency/LICENSE").read(), b"fixture dependency license\n")
            self.assertIn("go/src/runtime/proc.go", stream.getnames())
            self.assertNotIn("go/bin/go", stream.getnames())

    def test_existing_destination_never_overwritten(self):
        lock, work = self.prepared()
        destination = self.root / "pack"
        destination.mkdir()
        sentinel = destination / "keep"
        sentinel.write_text("existing")
        with self.assertRaises(FileExistsError):
            build.package_materials(lock, work, destination)
        self.assertEqual(sentinel.read_text(), "existing")

    def supplement_fixture(self, lock):
        directory = self.root / "notices"
        directory.mkdir()
        data = b"fixture upstream complete license\n"
        (directory / "dependency-LICENSE").write_bytes(data)
        record = {"path": "licenses/supplement/dependency-LICENSE", "sha256": build.digest(data), "bytes": len(data)}
        review = {"schemaVersion": 1, "sourceLockSha256": build.digest(build.json_bytes(lock)), "reviews": [{"scope": "example.com/dependency", "notices": [record]}]}
        path = self.root / "review.json"
        path.write_bytes(build.json_bytes(review))
        return path, directory, record

    def test_supplement_preserved_and_bound(self):
        lock, work = self.prepared()
        review, notices, record = self.supplement_fixture(lock)
        result = build.package_materials(lock, work, self.root / "pack", review, notices)
        with tarfile.open(self.root / "pack" / result["archive"]["file"], "r:gz") as stream:
            self.assertEqual(build.digest(stream.extractfile(record["path"]).read()), record["sha256"])
            self.assertEqual(stream.extractfile("licenses/review.json").read(), review.read_bytes())
        self.assertFalse(result["releaseReady"])

    def test_supplement_tamper_rejected(self):
        lock, work = self.prepared()
        review, notices, _ = self.supplement_fixture(lock)
        (notices / "dependency-LICENSE").write_bytes(b"other license")
        with self.assertRaisesRegex(build.BuildError, "supplement_digest_mismatch"):
            build.package_materials(lock, work, self.root / "pack", review, notices)

    def test_supplement_path_traversal_rejected(self):
        lock, work = self.prepared()
        review, notices, _ = self.supplement_fixture(lock)
        value = build.read_json(review)
        value["reviews"][0]["notices"][0]["path"] = "licenses/supplement/../outside"
        review.write_bytes(build.json_bytes(value))
        with self.assertRaises((build.BuildError, build.audit.AuditError)):
            build.package_materials(lock, work, self.root / "pack", review, notices)


if __name__ == "__main__":
    unittest.main()
