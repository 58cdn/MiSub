#!/usr/bin/env python3
"""Build a fixed Mihomo source snapshot using explicitly supplied local materials.

No downloads, package installation, signing, publication or proxy execution occur.
The result describes local build evidence; it is not authenticated provenance.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import pathlib
import platform
import re
import stat
import struct
import subprocess
import sys
import tarfile
import unicodedata
import zipfile

import audit_distribution as audit

ROOT = pathlib.Path(__file__).resolve().parents[1]
TARGETS = {"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64"}
MAX_ARCHIVE = 128 * 1024 * 1024
MAX_EXPANDED = 768 * 1024 * 1024
MAX_MEMBERS = 30000
MAX_MEMBER = 128 * 1024 * 1024
EMPTY_SHA = hashlib.sha256(b"").hexdigest()


class BuildError(ValueError):
    pass


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode()


def save_json(path, value):
    with path.open("xb") as output:
        output.write(json_bytes(value))


def read_json(path):
    payload = audit.read_snapshot(pathlib.Path(path), 16 * 1024 * 1024)
    return json.loads(payload, object_pairs_hook=audit.unique_object)


def host_target():
    system = {"Linux": "linux", "Darwin": "darwin", "Windows": "windows"}.get(platform.system())
    arch = {"x86_64": "amd64", "AMD64": "amd64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    target = f"{system}-{arch}"
    if target not in TARGETS:
        raise BuildError("unsupported_build_host")
    return target


def load_lock(path):
    lock = read_json(path)
    if set(lock) != {"schemaVersion", "source", "vendor", "toolchain", "targets", "minimumOS", "tags", "replacements"}:
        raise BuildError("invalid_source_build_lock")
    if type(lock["schemaVersion"]) is not int or lock["schemaVersion"] != 1 or set(lock["targets"]) != TARGETS:
        raise BuildError("invalid_source_build_lock")
    source = lock["source"]
    if set(source) != {"repository", "version", "commit", "tree", "url", "sha256", "prefix", "buildTime", "epoch", "caMode", "caPath", "caSha256"}:
        raise BuildError("invalid_source_lock")
    if not all(re.fullmatch(r"[0-9a-f]{40}", source[k]) for k in ("commit", "tree")):
        raise BuildError("invalid_source_revision")
    if source["caMode"] != "system" or source["caSha256"] != EMPTY_SHA or source["caPath"] != "component/ca/ca-certificates.crt":
        raise BuildError("unsupported_ca_mode")
    if lock["tags"] != ["with_gvisor"] or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+-misub-source", source["version"]):
        raise BuildError("invalid_build_recipe")
    if source["repository"] != "MetaCubeX/mihomo" or source["prefix"] != "mihomo-" + source["commit"] or source["url"] != "https://codeload.github.com/MetaCubeX/mihomo/tar.gz/" + source["commit"]:
        raise BuildError("invalid_source_location")
    vendor = lock["vendor"]
    release = source["version"].removesuffix("-misub-source")
    if set(vendor) != {"url", "sha256", "prefix"} or vendor["prefix"] != "vendor" or vendor["url"] != "https://github.com/MetaCubeX/mihomo/releases/download/" + release + "/vendor.tar.gz":
        raise BuildError("invalid_vendor_location")
    if not re.fullmatch(r"[0-9TZ:-]+", source["buildTime"]) or type(source["epoch"]) is not int or source["epoch"] < 0:
        raise BuildError("invalid_build_time")
    if set(lock["toolchain"]) != {"version", "hosts"} or set(lock["toolchain"]["hosts"]) != TARGETS:
        raise BuildError("invalid_toolchain_lock")
    if not re.fullmatch(r"go[0-9]+\.[0-9]+\.[0-9]+", lock["toolchain"]["version"]):
        raise BuildError("invalid_toolchain_version")
    for host, entry in lock["toolchain"]["hosts"].items():
        expected = lock["toolchain"]["version"] + "." + host + (".zip" if host.startswith("windows-") else ".tar.gz")
        if set(entry) != {"file", "sha256"} or entry["file"] != expected:
            raise BuildError("invalid_toolchain_location")
    for entry in [source, lock["vendor"], *lock["toolchain"]["hosts"].values()]:
        if not isinstance(entry, dict) or not re.fullmatch(r"[0-9a-f]{64}", entry.get("sha256", "")):
            raise BuildError("invalid_material_digest")
    return lock


class SourceTarInfo(audit.BoundedTarInfo):
    def _proc_pax(self, archive):
        # GitHub source archives contain a single global commit comment. It has
        # no path/size semantics and is checked against the expected commit below.
        if self.type == tarfile.XGLTYPE:
            if self.size > 1024 or archive.pax_headers:
                raise BuildError("unsupported_global_pax")
            result = self._bounded_extension(archive, super(audit.BoundedTarInfo, self)._proc_pax)
            if set(archive.pax_headers) != {"comment"}:
                raise BuildError("unsupported_global_pax")
            return result
        return super()._proc_pax(archive)


def archive_files(payload, prefix, format_name, commit=None):
    """Yield regular bytes only, with bounded parsing and portable path checks."""
    seen, parents, regular = set(), set(), set()
    count, expanded = 0, 0

    def check(name, directory, size, mode):
        nonlocal count, expanded
        count += 1
        expanded += size
        if count > MAX_MEMBERS or expanded > MAX_EXPANDED or size < 0 or size > MAX_MEMBER:
            raise BuildError("archive_resource_limit")
        name = audit.canonical_path(name, directory)
        key = unicodedata.normalize("NFC", name).casefold()
        if key in seen:
            raise BuildError("archive_duplicate_path")
        seen.add(key)
        if name == "." and directory:
            return None
        if name != prefix and not name.startswith(prefix + "/"):
            raise BuildError("archive_prefix_mismatch")
        chain = ["/".join(key.split("/")[:i]) for i in range(1, len(key.split("/")))]
        if any(p in regular for p in chain) or not directory and key in parents:
            raise BuildError("archive_path_type_conflict")
        parents.update(chain)
        if directory:
            if size:
                raise BuildError("directory_payload")
            return None
        if name == prefix:
            raise BuildError("archive_prefix_is_file")
        if stat.S_IFMT(mode) not in (0, stat.S_IFREG):
            raise BuildError("archive_special_file")
        regular.add(key)
        return name[len(prefix) + 1:]

    if format_name == "tar.gz":
        with gzip.GzipFile(fileobj=io.BytesIO(payload)) as decompressed:
            reader = audit.LimitedReader(decompressed, MAX_EXPANDED)
            with tarfile.open(fileobj=reader, mode="r|", tarinfo=SourceTarInfo, bufsize=512) as archive:
                for entry in archive:
                    if archive.pax_headers and archive.pax_headers != {"comment": commit}:
                        raise BuildError("source_commit_comment_mismatch")
                    if not (entry.isfile() or entry.isdir()) or entry.issparse():
                        raise BuildError("archive_special_file")
                    relative = check(entry.name, entry.isdir(), entry.size, entry.mode)
                    if relative is not None:
                        with archive.extractfile(entry) as stream:
                            data = stream.read(entry.size + 1)
                        if len(data) != entry.size:
                            raise BuildError("archive_truncated_member")
                        yield relative, data, 0o755 if entry.mode & 0o111 else 0o644
            while tail := reader.read(audit.CHUNK):
                if any(tail):
                    raise BuildError("archive_trailing_data")
    elif format_name == "zip":
        end = payload.rfind(b"PK\x05\x06", max(0, len(payload) - 65557))
        if end < 0 or len(payload) - end < 22 or end >= 20 and payload[end - 20:end - 16] == b"PK\x06\x07":
            raise BuildError("invalid_zip_directory")
        _, disk, directory_disk, disk_count, count_entries, directory_size, offset, comment = struct.unpack_from("<4s4H2IH", payload, end)
        if disk or directory_disk or disk_count != count_entries or count_entries > MAX_MEMBERS or directory_size > 16 * 1024 * 1024 or offset + directory_size != end or end + 22 + comment != len(payload):
            raise BuildError("invalid_zip_directory")
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            if len(archive.infolist()) != count_entries:
                raise BuildError("invalid_zip_directory")
            for entry in archive.infolist():
                if entry.flag_bits & 1 or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                    raise BuildError("unsupported_zip_encoding")
                if entry.orig_filename != entry.filename:
                    raise BuildError("invalid_zip_name")
                mode = entry.external_attr >> 16
                if entry.external_attr & 0x400:
                    raise BuildError("archive_reparse_entry")
                relative = check(entry.filename, entry.is_dir(), entry.file_size, mode)
                if relative is not None:
                    with archive.open(entry) as stream:
                        data = stream.read(entry.file_size + 1)
                    if len(data) != entry.file_size:
                        raise BuildError("archive_truncated_member")
                    yield relative, data, 0o755 if mode & 0o111 else 0o644
    else:
        raise BuildError("unsupported_archive_format")


def git_tree(files):
    tree = {}
    for name, data, mode in files:
        node = tree
        parts = name.split("/")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
            if not isinstance(node, dict):
                raise BuildError("git_tree_path_conflict")
        if parts[-1] in node:
            raise BuildError("git_tree_duplicate")
        node[parts[-1]] = (mode, hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).digest())

    def encode(node):
        result = bytearray()
        for name in sorted(node, key=lambda key: (key + ("/" if isinstance(node[key], dict) else "")).encode()):
            value = node[name]
            mode, sha = ("40000", encode(value)) if isinstance(value, dict) else ("100755" if value[0] & 0o111 else "100644", value[1])
            result.extend(mode.encode() + b" " + name.encode() + b"\0" + sha)
        return hashlib.sha1(b"tree " + str(len(result)).encode() + b"\0" + result).digest()
    return encode(tree).hex()


def locked_payload(path, expected):
    payload = audit.read_snapshot(pathlib.Path(path), MAX_ARCHIVE)
    if digest(payload) != expected:
        raise BuildError("material_checksum_mismatch")
    return payload


def write_files(destination, files):
    inventory = []
    destination.mkdir(parents=True, exist_ok=False)
    for name, data, mode in files:
        output = destination.joinpath(*name.split("/"))
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("xb") as stream:
            stream.write(data)
        output.chmod(mode)
        inventory.append({"path": name, "sha256": digest(data), "bytes": len(data), "mode": mode})
    return inventory


def verify_files(directory, inventory):
    if directory.is_symlink() or getattr(directory, "is_junction", lambda: False)():
        raise BuildError("prepared_tree_link")
    expected = {item["path"] for item in inventory}
    actual = set()
    for path in directory.rglob("*"):
        if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
            raise BuildError("prepared_tree_link")
        if path.is_file():
            actual.add(path.relative_to(directory).as_posix())
    if actual != expected:
        raise BuildError("prepared_tree_file_set_changed")
    for item in inventory:
        path = directory.joinpath(*item["path"].split("/"))
        data = audit.read_snapshot(path, item["bytes"])
        if len(data) != item["bytes"] or digest(data) != item["sha256"]:
            raise BuildError("prepared_tree_bytes_changed")
        if os.name != "nt" and stat.S_IMODE(path.stat().st_mode) != item["mode"]:
            raise BuildError("prepared_tree_mode_changed")


def prepare(lock, source_archive, vendor_archive, toolchain_archive, work, host):
    if host not in lock["toolchain"]["hosts"]:
        raise BuildError("unsupported_build_host")
    source = lock["source"]
    source_payload = locked_payload(source_archive, source["sha256"])
    vendor_payload = locked_payload(vendor_archive, lock["vendor"]["sha256"])
    tool = lock["toolchain"]["hosts"][host]
    tool_payload = locked_payload(toolchain_archive, tool["sha256"])
    source_files = list(archive_files(source_payload, source["prefix"], "tar.gz", source["commit"]))
    if git_tree(source_files) != source["tree"]:
        raise BuildError("source_git_tree_mismatch")
    if not any(name == source["caPath"] and data == b"" for name, data, _ in source_files):
        raise BuildError("source_system_ca_input_mismatch")
    work.mkdir(parents=True, exist_ok=False)
    (work / "materials").mkdir()
    for name, payload in (("source.archive", source_payload), ("vendor.archive", vendor_payload), ("toolchain.archive", tool_payload)):
        with (work / "materials" / name).open("xb") as stream:
            stream.write(payload)
    source_inventory = write_files(work / "source", source_files)
    vendor_inventory = write_files(work / "source/vendor", archive_files(vendor_payload, lock["vendor"]["prefix"], "tar.gz"))
    source_inventory.extend(dict(item, path="vendor/" + item["path"]) for item in vendor_inventory)
    tool_inventory = write_files(work / "toolchain", archive_files(tool_payload, "go", "zip" if tool["file"].endswith(".zip") else "tar.gz"))
    if (work / "toolchain/VERSION").read_text().splitlines()[0] != lock["toolchain"]["version"]:
        raise BuildError("toolchain_version_file_mismatch")
    modules = audit.module_inventory((work / "source/vendor/modules.txt").read_text())
    replacements = [m for m in modules if m["version"] and m["replacement"]]
    if replacements != lock["replacements"]:
        raise BuildError("vendor_replacement_mismatch")
    state = {"schemaVersion": 1, "kind": "misub-core-prepared", "lock": lock, "lockSha256": digest(json_bytes(lock)), "host": host,
             "sourceFiles": source_inventory, "toolchainFiles": tool_inventory, "modules": modules,
             "releaseReady": False, "authenticatedProvenance": "missing"}
    save_json(work / "prepared.json", state)
    return {"schemaVersion": 1, "kind": state["kind"], "sourceFiles": len(source_inventory), "toolchainFiles": len(tool_inventory), "sourceTree": source["tree"], "releaseReady": False}


def load_prepared(work, lock):
    state = read_json(work / "prepared.json")
    if state.get("kind") != "misub-core-prepared" or state.get("schemaVersion") != 1 or state.get("lock") != lock or state.get("lockSha256") != digest(json_bytes(lock)):
        raise BuildError("prepared_lock_mismatch")
    if state.get("host") not in lock["toolchain"]["hosts"]:
        raise BuildError("unsupported_build_host")
    # prepared.json is a report, not a trust anchor. Derive its inventories again
    # from immutable snapshots whose digests are fixed by the reviewed lock.
    source = lock["source"]
    tool = lock["toolchain"]["hosts"][state["host"]]
    source_payload = locked_payload(work / "materials/source.archive", source["sha256"])
    vendor_payload = locked_payload(work / "materials/vendor.archive", lock["vendor"]["sha256"])
    tool_payload = locked_payload(work / "materials/toolchain.archive", tool["sha256"])

    def inventory(files, prefix=""):
        return [{"path": prefix + name, "sha256": digest(data), "bytes": len(data), "mode": mode} for name, data, mode in files]

    source_files = list(archive_files(source_payload, source["prefix"], "tar.gz", source["commit"]))
    if git_tree(source_files) != source["tree"]:
        raise BuildError("source_git_tree_mismatch")
    expected_source = inventory(source_files)
    expected_source.extend(inventory(archive_files(vendor_payload, lock["vendor"]["prefix"], "tar.gz"), "vendor/"))
    expected_tool = inventory(archive_files(tool_payload, "go", "zip" if tool["file"].endswith(".zip") else "tar.gz"))
    if state["sourceFiles"] != expected_source or state["toolchainFiles"] != expected_tool:
        raise BuildError("prepared_inventory_mismatch")
    verify_files(work / "source", expected_source)
    verify_files(work / "toolchain", expected_tool)
    if state["modules"] != audit.module_inventory((work / "source/vendor/modules.txt").read_text()):
        raise BuildError("prepared_modules_mismatch")
    return state


def build_environment(work, target):
    env = {k: os.environ[k] for k in ("PATH", "SystemRoot", "WINDIR", "HOME", "USERPROFILE", "LOCALAPPDATA", "TMP", "TEMP") if k in os.environ}
    goos, goarch = target.split("-")
    env.update({"GOTOOLCHAIN": "local", "GOENV": "off", "GOWORK": "off", "GOFLAGS": "", "GOEXPERIMENT": "", "GOPROXY": "off", "GOSUMDB": "off", "GONOSUMDB": "", "GOPRIVATE": "", "CGO_ENABLED": "0", "GOOS": goos, "GOARCH": goarch, "GOAMD64": "v1", "GOARM64": "v8.0", "GOCACHE": str(work / "cache"), "GOMODCACHE": str(work / "module-cache"), "GOROOT": str(work / "toolchain")})
    return env


def run_go(go, args, work, env, output, timeout=1200):
    with output.open("xb") as stream:
        result = subprocess.run([str(go), *args], cwd=work / "source", env=env, stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT, timeout=timeout, check=False)
    if result.returncode:
        raise BuildError("go_command_failed:" + output.name)
    if output.stat().st_size > 32 * 1024 * 1024:
        raise BuildError("go_output_size_limit")
    return output.read_bytes()


def decode_packages(payload):
    text, offset, packages = payload.decode("utf-8"), 0, []
    decoder = json.JSONDecoder(object_pairs_hook=audit.unique_object)
    while offset < len(text):
        while offset < len(text) and text[offset].isspace():
            offset += 1
        if offset == len(text):
            break
        package, offset = decoder.raw_decode(text, offset)
        packages.append(package)
        if len(packages) > 5000:
            raise BuildError("package_count_limit")
    if not packages:
        raise BuildError("empty_dependency_graph")
    return packages


def dependency_evidence(packages, work, state):
    modules, files, seen = {}, [], set()
    source_root, tool_root = (work / "source").resolve(), (work / "toolchain").resolve()
    for package in packages:
        if package.get("Error") or package.get("DepsErrors") or package.get("Incomplete"):
            raise BuildError("incomplete_dependency_graph")
        module = package.get("Module", {})
        if module and not module.get("Main"):
            record = {"module": module["Path"], "version": module.get("Version"), "replacement": None}
            if module.get("Replace"):
                record["replacement"] = {"module": module["Replace"]["Path"], "version": module["Replace"].get("Version")}
            if record not in state["modules"]:
                raise BuildError("linked_module_not_in_vendor")
            modules[record["module"]] = record
        directory = pathlib.Path(package.get("Dir", "")).resolve()
        if not (directory.is_relative_to(source_root) or directory.is_relative_to(tool_root)):
            raise BuildError("dependency_outside_prepared_inputs")
        for key in ("GoFiles", "CgoFiles", "CFiles", "CXXFiles", "MFiles", "HFiles", "FFiles", "SFiles", "SysoFiles", "EmbedFiles"):
            for name in package.get(key, []):
                path = (directory / name).resolve()
                base, prefix = (source_root, "mihomo/") if path.is_relative_to(source_root) else (tool_root, "go/")
                if not path.is_relative_to(base) or not path.is_file():
                    raise BuildError("dependency_file_outside_inputs")
                relative = prefix + path.relative_to(base).as_posix()
                if relative not in seen:
                    size = path.stat().st_size
                    if size > MAX_MEMBER:
                        raise BuildError("dependency_file_size_limit")
                    data = audit.read_snapshot(path, size)
                    files.append({"path": relative, "sha256": digest(data), "bytes": len(data)})
                    seen.add(relative)
    return {"packages": len(packages), "modules": [modules[k] for k in sorted(modules)], "files": sorted(files, key=lambda f: f["path"])}


def build(lock, work, target, output):
    if target not in TARGETS:
        raise BuildError("unsupported_target")
    state = load_prepared(work, lock)
    if state["host"] != host_target():
        raise BuildError("toolchain_host_mismatch")
    output.mkdir(parents=True, exist_ok=False)
    env = build_environment(work, target)
    go = work / "toolchain/bin" / ("go.exe" if state["host"].startswith("windows-") else "go")
    version = run_go(go, ["version"], work, env, output / "go-version.txt").decode().strip()
    if version != "go version " + lock["toolchain"]["version"] + " " + state["host"].replace("-", "/"):
        raise BuildError("executed_toolchain_version_mismatch")
    deps = run_go(go, ["list", "-mod=vendor", "-deps", "-json", "-tags", ",".join(lock["tags"]), "."], work, env, output / "go-deps.json")
    evidence = dependency_evidence(decode_packages(deps), work, state)
    source = lock["source"]
    flags = "-buildid= -X github.com/metacubex/mihomo/constant.Version=" + source["version"] + " -X github.com/metacubex/mihomo/constant.BuildTime=" + source["buildTime"]
    recipe = ["build", "-mod=vendor", "-buildvcs=false", "-trimpath", "-tags", ",".join(lock["tags"]), "-ldflags", flags]
    filename = "mihomo-" + target + (".exe" if target.startswith("windows-") else "")
    first, second = output / filename, output / (filename + ".repeat")
    run_go(go, [*recipe, "-o", str(first), "."], work, env, output / "build.log")
    # A second invocation verifies byte equality under the fixed recipe. Native
    # runtime tests and independent-host rebuilding remain separate CI evidence.
    run_go(go, [*recipe, "-o", str(second), "."], work, env, output / "rebuild.log")
    first_data, second_data = audit.read_snapshot(first, MAX_MEMBER), audit.read_snapshot(second, MAX_MEMBER)
    if first_data != second_data:
        raise BuildError("rebuild_digest_mismatch")
    buildinfo = run_go(go, ["version", "-m", str(first)], work, env, output / "buildinfo.txt").decode()
    for expected in (lock["toolchain"]["version"], "GOOS=" + target.split("-")[0], "GOARCH=" + target.split("-")[1], "CGO_ENABLED=0", "-trimpath=true", "-tags=with_gvisor"):
        if expected not in buildinfo:
            raise BuildError("output_build_info_mismatch")
    verify_files(work / "source", state["sourceFiles"])
    verify_files(work / "toolchain", state["toolchainFiles"])
    result = {"schemaVersion": 1, "kind": "misub-core-build", "target": target, "host": state["host"], "lockSha256": state["lockSha256"],
              "source": source, "vendorSha256": lock["vendor"]["sha256"], "toolchain": {"version": version, "archiveSha256": lock["toolchain"]["hosts"][state["host"]]["sha256"]},
              "recipe": recipe, "environment": {k: env[k] for k in ("GOTOOLCHAIN", "GOPROXY", "GOSUMDB", "GOENV", "GOWORK", "CGO_ENABLED", "GOOS", "GOARCH", "GOAMD64", "GOARM64")},
              "output": {"file": filename, "sha256": digest(first_data), "bytes": len(first_data)}, "repeatBuildMatches": True,
              "dependencies": evidence, "caMode": "system", "nativeRuntimeTests": "not-performed-by-generator", "authenticatedProvenance": "missing", "releaseReady": False}
    save_json(output / "build-result.json", result)
    return {k: result[k] for k in ("schemaVersion", "kind", "target", "output", "repeatBuildMatches", "releaseReady")}


def package_materials(lock, work, output, license_review=None, supplement_dir=None):
    state = load_prepared(work, lock)
    output.mkdir(parents=True, exist_ok=False)
    entries, notices = [], []
    for prefix, directory, inventory in (("mihomo", work / "source", state["sourceFiles"]), ("go", work / "toolchain", state["toolchainFiles"])):
        for item in inventory:
            if prefix == "go" and not (item["path"].startswith("src/") or audit.NOTICE.fullmatch(pathlib.PurePosixPath(item["path"]).name) or item["path"] in ("VERSION", "go.env")):
                continue
            record = dict(item, path=prefix + "/" + item["path"])
            entries.append((record, directory / item["path"]))
            if audit.NOTICE.fullmatch(pathlib.PurePosixPath(item["path"]).name):
                notices.append(record)
    build_files = [("build/source-build-lock.json", json_bytes(lock)), ("build/source_build.py", pathlib.Path(__file__).read_bytes()), ("build/audit_distribution.py", pathlib.Path(audit.__file__).read_bytes())]
    if license_review is not None:
        review_bytes = audit.read_snapshot(license_review, 16 * 1024 * 1024)
        review = json.loads(review_bytes, object_pairs_hook=audit.unique_object)
        if review.get("schemaVersion") != 1 or review.get("sourceLockSha256") != state["lockSha256"]:
            raise BuildError("license_review_lock_mismatch")
        build_files.append(("licenses/review.json", review_bytes))
        supplement_records = {}
        for scope in review.get("reviews", []):
            for item in scope.get("notices", []):
                if item["path"].startswith("licenses/supplement/"):
                    name = item["path"][len("licenses/supplement/"):]
                    if audit.canonical_path(name) != name or "/" in name or supplement_dir is None:
                        raise BuildError("invalid_supplement_path")
                    if name in supplement_records and supplement_records[name] != item:
                        raise BuildError("conflicting_supplement_digest")
                    supplement_records[name] = item
        for name, item in sorted(supplement_records.items()):
            data = audit.read_snapshot(supplement_dir / name, 2 * 1024 * 1024)
            if not data or len(data) != item["bytes"] or digest(data) != item["sha256"]:
                raise BuildError("supplement_digest_mismatch")
            build_files.append((item["path"], data))
            notices.append(dict(item, mode=0o644))
    source_doc = ("# Mihomo corresponding source materials\n\n"
                  f"Source: {lock['source']['repository']} commit {lock['source']['commit']} (Git tree {lock['source']['tree']}).\n\n"
                  "The mihomo directory contains the exact source and effective vendored files used by the offline build. Its GPLv3 license and all collected dependency notices are retained. The go directory contains the pinned standard toolchain source and notices. Full files retain file-level copyright and license text.\n\n"
                  "The empty upstream CA file is intentional: the unmodified implementation uses the operating system certificate pool. TLS verification remains enabled; Linux requires installed system CA certificates.\n\n"
                  f"Toolchain: {lock['toolchain']['version']}. The host archive names and SHA256 values are in build/source-build-lock.json; official downloads are at https://go.dev/dl/. Build with the included source_build.py and explicitly supplied locked archives.\n\n"
                  "This archive covers the core and toolchain, not the MiSub wrapper. Distribute the matching wrapper source and recipe separately. A local manifest is not a signed provenance assertion. Review applicable notice coverage and verify authenticated CI evidence before publication.\n")
    build_files.append(("SOURCE.md", source_doc.encode()))
    inventory = [record for record, _ in entries]
    inventory.extend({"path": name, "sha256": digest(data), "bytes": len(data), "mode": 0o644} for name, data in build_files)
    manifest = {"schemaVersion": 1, "kind": "misub-core-source-pack", "lockSha256": state["lockSha256"], "source": lock["source"], "vendor": lock["vendor"], "toolchain": lock["toolchain"], "host": state["host"],
                "files": sorted(inventory, key=lambda item: item["path"]), "notices": sorted(notices, key=lambda item: item["path"]), "modules": state["modules"],
                "noticeCoverage": "requires-review", "authenticatedProvenance": "missing", "releaseReady": False}
    archive_path = output / "mihomo-source-materials.tar.gz"
    with archive_path.open("xb") as raw, gzip.GzipFile(fileobj=raw, mode="wb", mtime=0, filename="") as compressed, tarfile.open(fileobj=compressed, mode="w|", format=tarfile.PAX_FORMAT) as archive:
        sources = [(record["path"], record["mode"], path.read_bytes()) for record, path in entries]
        sources.extend((name, 0o644, data) for name, data in build_files)
        sources.append(("manifest.json", 0o644, json_bytes(manifest)))
        for name, mode, data in sorted(sources):
            item = tarfile.TarInfo(name)
            item.size, item.mode, item.mtime = len(data), mode, lock["source"]["epoch"]
            archive.addfile(item, io.BytesIO(data))
    verify_files(work / "source", state["sourceFiles"])
    verify_files(work / "toolchain", state["toolchainFiles"])
    result = {"schemaVersion": 1, "kind": manifest["kind"], "lockSha256": state["lockSha256"], "archive": {"file": archive_path.name, "sha256": digest(archive_path.read_bytes()), "bytes": archive_path.stat().st_size},
              "sourceFileCount": len(state["sourceFiles"]), "packFileCount": len(inventory), "noticeFileCount": len(notices), "noticeCoverage": "requires-review", "authenticatedProvenance": "missing", "releaseReady": False}
    save_json(output / "source-pack-result.json", result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=pathlib.Path, default=ROOT / "source-build-lock.json")
    commands = parser.add_subparsers(dest="command", required=True)
    prep = commands.add_parser("prepare")
    for name in ("source-archive", "vendor-archive", "toolchain-archive", "work-dir"):
        prep.add_argument("--" + name, type=pathlib.Path, required=True)
    compile_parser = commands.add_parser("build")
    compile_parser.add_argument("--target", choices=sorted(TARGETS), required=True)
    package_parser = commands.add_parser("package")
    package_parser.add_argument("--license-review", type=pathlib.Path)
    package_parser.add_argument("--supplement-dir", type=pathlib.Path)
    for command in (compile_parser, package_parser):
        command.add_argument("--work-dir", type=pathlib.Path, required=True)
        command.add_argument("--output-dir", type=pathlib.Path, required=True)
    args = parser.parse_args(argv)
    try:
        lock = load_lock(args.lock)
        work = args.work_dir.resolve()
        if args.command == "prepare":
            result = prepare(lock, args.source_archive, args.vendor_archive, args.toolchain_archive, work, host_target())
        elif args.command == "build":
            result = build(lock, work, args.target, args.output_dir.resolve())
        else:
            result = package_materials(lock, work, args.output_dir.resolve(), args.license_review, args.supplement_dir)
        print(json.dumps(result, sort_keys=True))
        return 0
    except (BuildError, audit.AuditError, OSError, ValueError, KeyError, TypeError, EOFError, tarfile.TarError, zipfile.BadZipFile, subprocess.SubprocessError) as error:
        print(json.dumps({"releaseReady": False, "error": str(error) if isinstance(error, (BuildError, audit.AuditError)) else "source_build_failed"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
