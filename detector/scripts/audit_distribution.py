#!/usr/bin/env python3
"""Offline, read-only inventory of explicitly supplied distribution materials.

This verifies bytes and archive structure, not build provenance or license
completeness. It never executes archive contents or downloads dependencies.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import pathlib
import re
import stat
import struct
import sys
import tarfile
import unicodedata
import zipfile
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
CHUNK = 64 * 1024
LIMITS = {
    "compressedBytes": 96 * 1024 * 1024,
    "expandedBytes": 512 * 1024 * 1024,
    "memberBytes": 128 * 1024 * 1024,
    "members": 30000,
    "metadataBytes": 1024 * 1024,
    "noticeBytes": 2 * 1024 * 1024,
    "totalNoticeBytes": 24 * 1024 * 1024,
    "modules": 2048,
}
TARGETS = {"linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64"}
NOTICE = re.compile(r"^(license|licence|copying|notice|copyright|patents|authors)([._-].*)?$", re.I)
HEX = re.compile(r"^[0-9a-f]{64}$")
IDENTIFIER = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


class AuditError(ValueError):
    pass


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise AuditError("duplicate_json_key")
        result[key] = value
    return result


def read_json(path):
    with pathlib.Path(path).open("rb") as stream:
        data = stream.read(LIMITS["metadataBytes"] + 1)
    if len(data) > LIMITS["metadataBytes"]:
        raise AuditError("json_size_limit")
    return json.loads(data, object_pairs_hook=unique_object)


def canonical_path(name, directory=False):
    if not isinstance(name, str) or len(name) > 1024 or any(char in name for char in '\\:<>"|?*'):
        raise AuditError("unsafe_archive_path")
    if name.startswith("/") or any(ord(char) < 32 or ord(char) == 127 for char in name):
        raise AuditError("unsafe_archive_path")
    while name.startswith("./"):
        name = name[2:]
    if directory:
        name = name.rstrip("/")
    if name in ("", ".") and directory:
        return "."
    parts = name.split("/")
    if len(parts) > 32:
        raise AuditError("archive_path_depth_limit")
    if any(part in ("", ".", "..") or part.endswith((" ", ".")) for part in parts):
        raise AuditError("unsafe_archive_path")
    for part in parts:
        if re.fullmatch(r"(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?", part, re.I):
            raise AuditError("unsafe_archive_path")
    return "/".join(parts)


def validate_lock(lock, kernel):
    if not isinstance(lock, dict) or set(lock) != {"schemaVersion", "core", "artifacts"}:
        raise AuditError("invalid_distribution_lock")
    if type(lock["schemaVersion"]) is not int or lock["schemaVersion"] != 1:
        raise AuditError("invalid_distribution_lock")
    if lock["core"] != {key: kernel[key] for key in ("repository", "version", "sourceCommit")}:
        raise AuditError("kernel_source_lock_mismatch")
    if not isinstance(lock["artifacts"], list) or not 1 <= len(lock["artifacts"]) <= 16:
        raise AuditError("invalid_distribution_lock")
    if not isinstance(kernel["assets"], dict) or set(kernel["assets"]) != TARGETS:
        raise AuditError("invalid_kernel_targets")
    ids, targets = set(), set()
    for artifact in lock["artifacts"]:
        fields = {
            "id", "role", "format", "url", "sha256", "target", "prefix", "requiredFiles"
        }
        if isinstance(artifact, dict) and artifact.get("format") == "zip":
            fields |= {"entry", "executableSha256", "executableBytes"}
        if not isinstance(artifact, dict) or set(artifact) != fields:
            raise AuditError("invalid_artifact_lock")
        identifier = artifact["id"]
        if not isinstance(identifier, str) or not IDENTIFIER.fullmatch(identifier) or identifier in ids:
            raise AuditError("invalid_artifact_id")
        ids.add(identifier)
        if artifact["role"] not in {"kernel", "vendor", "toolchain", "historical-core-source"}:
            raise AuditError("invalid_artifact_role")
        if artifact["format"] not in {"gzip", "tar.gz", "zip"}:
            raise AuditError("invalid_artifact_format")
        if not isinstance(artifact["sha256"], str) or not HEX.fullmatch(artifact["sha256"]):
            raise AuditError("invalid_artifact_digest")
        if not isinstance(artifact["url"], str) or not re.fullmatch(
            r"https://github\.com/(MetaCubeX/mihomo|58cdn/MiSub)/releases/download/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+",
            artifact["url"],
        ):
            raise AuditError("invalid_artifact_source")
        if artifact["role"] == "kernel":
            target = artifact["target"]
            expected_format = "zip" if target == "windows-amd64" else "gzip"
            if target not in TARGETS or target in targets or artifact["format"] != expected_format:
                raise AuditError("invalid_kernel_target")
            targets.add(target)
            expected = kernel["assets"][target]
            url = f'https://github.com/{kernel["repository"]}/releases/download/{kernel["version"]}/{expected["file"]}'
            if artifact["sha256"] != expected["sha256"] or artifact["url"] != url:
                raise AuditError("kernel_asset_lock_mismatch")
            if artifact["prefix"] != "" or artifact["requiredFiles"] != []:
                raise AuditError("invalid_kernel_archive_metadata")
            if expected_format == "zip":
                if not isinstance(artifact["entry"], str) or not re.fullmatch(r"mihomo-[a-z0-9.-]+\.exe", artifact["entry"]):
                    raise AuditError("invalid_kernel_entry")
                if not isinstance(artifact["executableSha256"], str) or not HEX.fullmatch(artifact["executableSha256"]):
                    raise AuditError("invalid_kernel_executable_digest")
                if type(artifact["executableBytes"]) is not int or not 0 < artifact["executableBytes"] <= LIMITS["memberBytes"]:
                    raise AuditError("invalid_kernel_executable_size")
                if any(artifact[key] != expected.get(key) for key in ("entry", "executableSha256", "executableBytes")):
                    raise AuditError("kernel_executable_lock_mismatch")
        elif artifact["target"] is not None or artifact["format"] != "tar.gz":
            raise AuditError("invalid_artifact_target")
        if artifact["prefix"] and canonical_path(artifact["prefix"]) != artifact["prefix"]:
            raise AuditError("invalid_archive_prefix")
        files = artifact["requiredFiles"]
        if not isinstance(files, list) or len(files) > 16 or len(set(files)) != len(files):
            raise AuditError("invalid_required_files")
        for name in files:
            canonical_path(name)
    if targets != TARGETS:
        raise AuditError("missing_kernel_target")


class LimitedReader:
    def __init__(self, stream, maximum):
        self.stream, self.maximum, self.count = stream, maximum, 0

    def read(self, size=-1):
        size = min(size if size >= 0 else CHUNK, self.maximum - self.count + 1)
        data = self.stream.read(size)
        self.count += len(data)
        if self.count > self.maximum:
            raise AuditError("expanded_size_limit")
        return data


class BoundedTarInfo(tarfile.TarInfo):
    # tarfile processes extension headers before yielding members. Cap them too.
    def _proc_pax(self, archive):
        if self.type == tarfile.XGLTYPE:
            raise AuditError("global_pax_header_unsupported")
        if self.size < 0 or self.size > LIMITS["metadataBytes"]:
            raise AuditError("archive_metadata_size_limit")
        result = self._bounded_extension(archive, super()._proc_pax)
        if len(result.pax_headers) > 64:
            raise AuditError("archive_metadata_field_limit")
        return result

    def _proc_gnulong(self, archive):
        if self.size < 0 or self.size > LIMITS["metadataBytes"]:
            raise AuditError("archive_metadata_size_limit")
        return self._bounded_extension(archive, super()._proc_gnulong)

    def _bounded_extension(self, archive, process):
        depth = getattr(archive, "_audit_extension_depth", 0)
        if depth >= 4:
            raise AuditError("archive_metadata_depth_limit")
        archive._audit_extension_depth = depth + 1
        try:
            return process(archive)
        finally:
            archive._audit_extension_depth = depth


def module_inventory(text):
    """Retain effective replacements from Go's generated vendor/modules.txt."""
    modules, seen = [], set()
    for line in text.splitlines():
        if not line.startswith("# "):
            continue
        fields = line[2:].split()
        if not fields or fields[0].startswith("#"):
            continue
        if "=>" in fields:
            offset = fields.index("=>")
            source, replacement = fields[:offset], fields[offset + 1:]
        else:
            source, replacement = fields, []
        if len(source) not in (1, 2) or len(replacement) not in (0, 1, 2):
            raise AuditError("invalid_vendor_modules")
        item = {"module": source[0], "version": source[1] if len(source) == 2 else None}
        item["replacement"] = None if not replacement else {
            "module": replacement[0], "version": replacement[1] if len(replacement) == 2 else None
        }
        # A replacement-only footer is retained separately from a versioned entry.
        key = tuple(source) + ("=>",) + tuple(replacement)
        if key not in seen:
            if len(modules) >= LIMITS["modules"]:
                raise AuditError("vendor_module_limit")
            seen.add(key)
            modules.append(item)
    if not modules:
        raise AuditError("empty_vendor_modules")
    return modules


def scan_archive(stream, artifact, limits):
    reader = LimitedReader(stream, limits["expandedBytes"])
    inventory, notices, texts, seen, file_names, used_parents = [], {}, {}, set(), set(), set()
    notice_size = 0
    with tarfile.open(fileobj=reader, mode="r|", tarinfo=BoundedTarInfo, bufsize=512) as archive:
        for member in archive:
            if len(inventory) >= limits["members"]:
                raise AuditError("archive_member_limit")
            if not (member.isfile() or member.isdir()) or member.issparse():
                raise AuditError("unsafe_archive_member_type")
            if member.size < 0 or member.size > limits["memberBytes"]:
                raise AuditError("archive_member_size_limit")
            if member.isdir() and member.size:
                raise AuditError("directory_has_payload")
            name = canonical_path(member.name, member.isdir())
            key = unicodedata.normalize("NFC", name).casefold()
            if key in seen:
                raise AuditError("duplicate_archive_path")
            seen.add(key)
            prefix = artifact["prefix"]
            if prefix and name != "." and name != prefix and not name.startswith(prefix + "/"):
                raise AuditError("archive_prefix_mismatch")
            # Reject a regular file reused as a parent, regardless of entry order.
            parent_keys = ["/".join(key.split("/")[:i]) for i in range(1, len(key.split("/")))]
            if any(parent in file_names for parent in parent_keys):
                raise AuditError("archive_path_type_conflict")
            if member.isfile() and key in used_parents:
                raise AuditError("archive_path_type_conflict")
            used_parents.update(parent_keys)
            if member.isdir():
                inventory.append({"path": name, "type": "directory"})
                continue
            file_names.add(key)
            is_notice = bool(NOTICE.fullmatch(name.rsplit("/", 1)[-1]))
            metadata_paths = {prefix + "/" + suffix for suffix in ("modules.txt", "vendor/modules.txt", "go.mod", "VERSION")}
            capture = is_notice or name in metadata_paths
            if is_notice:
                notice_size += member.size
                if member.size > limits["noticeBytes"] or notice_size > limits["totalNoticeBytes"]:
                    raise AuditError("notice_size_limit")
            elif capture and member.size > limits["metadataBytes"]:
                raise AuditError("metadata_size_limit")
            digest, size, captured = hashlib.sha256(), 0, bytearray()
            with archive.extractfile(member) as source:
                while chunk := source.read(CHUNK):
                    digest.update(chunk)
                    size += len(chunk)
                    if capture:
                        captured.extend(chunk)
            if size != member.size:
                raise AuditError("truncated_archive_member")
            entry = {"path": name, "type": "file", "size": size, "sha256": digest.hexdigest()}
            inventory.append(entry)
            if is_notice:
                notices[name] = bytes(captured)
            elif capture:
                texts[name] = bytes(captured)
    # Validate the gzip trailer and reject a second hidden archive after tar EOF.
    while tail := reader.read(CHUNK):
        if any(tail):
            raise AuditError("trailing_archive_data")
    files = {entry["path"]: entry for entry in inventory if entry["type"] == "file"}
    required = [f'{artifact["prefix"]}/{name}' if artifact["prefix"] else name for name in artifact["requiredFiles"]]
    missing = [name for name in required if name not in files or files[name]["size"] == 0]
    module_path = next((name for name in texts if name.endswith("/vendor/modules.txt")), None)
    if module_path is None and "vendor/modules.txt" in texts:
        module_path = "vendor/modules.txt"
    modules = module_inventory(texts[module_path].decode("utf-8")) if module_path else []
    notice_entries = [entry for entry in inventory if entry["path"] in notices]
    for module in modules:
        vendor_root = module_path[:-len("modules.txt")]
        prefix = vendor_root + module["module"] + "/"
        module["noticePaths"] = [entry["path"] for entry in notice_entries if entry["path"].startswith(prefix)]
    return {
        "expandedBytes": reader.count,
        "inventory": inventory,
        "noticeFiles": notice_entries,
        "modules": modules,
        "missingRequiredFiles": missing,
        "noticeCoverage": "unverified",
        "toolchainVersion": next((data.decode("utf-8").strip() for name, data in texts.items() if name.endswith("/VERSION")), None),
    }, notices


def read_snapshot(path, maximum):
    if path.is_symlink():
        raise AuditError("artifact_not_regular_file")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise AuditError("artifact_not_regular_file")
        payload = source.read(maximum + 1)
    if len(payload) > maximum:
        raise AuditError("compressed_size_limit")
    return payload


def validate_zip_extra(extra):
    seen, offset = set(), 0
    while offset < len(extra):
        if len(extra) - offset < 4:
            raise AuditError("invalid_zip_extra")
        kind, size = struct.unpack_from("<HH", extra, offset)
        offset += 4
        if size > len(extra) - offset or kind in seen:
            raise AuditError("invalid_zip_extra")
        # Small locked assets need neither ZIP64 nor alternate path/encryption metadata.
        if kind in (0x0001, 0x7075, 0x9901):
            raise AuditError("unsupported_zip_extra")
        seen.add(kind)
        offset += size


def scan_kernel_zip(payload, artifact, limits):
    # Preflight the directory before ZipFile allocates a list of member metadata.
    end = payload.rfind(b"PK\x05\x06", max(0, len(payload) - 65557))
    if end < 0 or len(payload) - end < 22:
        raise AuditError("invalid_zip_directory")
    # ZipFile consults this locator even when the ordinary EOCD has no ZIP64
    # sentinel values. It must not select a directory outside this preflight.
    if end >= 20 and payload[end - 20:end - 16] == b"PK\x06\x07":
        raise AuditError("unsupported_zip64_locator")
    _, disk, directory_disk, disk_count, count, directory_size, directory_offset, comment_size = struct.unpack_from("<4s4H2IH", payload, end)
    if disk or directory_disk or disk_count != 1 or count != 1 or limits["members"] < 1:
        raise AuditError("zip_requires_one_executable")
    if directory_size > limits["metadataBytes"] or directory_size < 46:
        raise AuditError("archive_metadata_size_limit")
    if end + 22 + comment_size != len(payload) or directory_offset + directory_size != end:
        raise AuditError("trailing_or_hidden_zip_data")
    if directory_offset < 30 or payload[directory_offset:directory_offset + 4] != b"PK\x01\x02":
        raise AuditError("invalid_zip_directory")
    if struct.unpack_from("<H", payload, directory_offset + 6)[0] > 20:
        raise AuditError("unsupported_zip_version")
    name_size, extra_size, entry_comment_size, start_disk = struct.unpack_from("<4H", payload, directory_offset + 28)
    if start_disk or 46 + name_size + extra_size + entry_comment_size != directory_size:
        raise AuditError("invalid_zip_directory")
    central_name = payload[directory_offset + 46:directory_offset + 46 + name_size]
    validate_zip_extra(payload[directory_offset + 46 + name_size:directory_offset + 46 + name_size + extra_size])
    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        entries = archive.infolist()
        if len(entries) != 1:
            raise AuditError("zip_requires_one_executable")
        entry = entries[0]
        name = canonical_path(entry.orig_filename)
        if entry.orig_filename != name or name != artifact["entry"] or entry.filename != name:
            raise AuditError("kernel_entry_mismatch")
        mode = entry.external_attr >> 16
        if entry.is_dir() or entry.external_attr & 0x18 or stat.S_IFMT(mode) not in (0, stat.S_IFREG):
            raise AuditError("unsafe_archive_member_type")
        if entry.flag_bits & ~0x080e or entry.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            raise AuditError("unsupported_zip_encoding")
        if entry.header_offset != 0 or payload[:4] != b"PK\x03\x04":
            raise AuditError("hidden_zip_prefix")
        if entry.file_size <= 0 or entry.file_size > limits["memberBytes"]:
            raise AuditError("archive_member_size_limit")
        if entry.file_size > limits["expandedBytes"]:
            raise AuditError("expanded_size_limit")
        if entry.file_size != artifact["executableBytes"]:
            raise AuditError("kernel_executable_size_mismatch")
        _, version, flags, method, _, _, crc, compressed, expanded, local_name_size, local_extra_size = struct.unpack_from("<4s5H3I2H", payload)
        header_size = 30 + local_name_size + local_extra_size
        if header_size + directory_size + comment_size > limits["metadataBytes"]:
            raise AuditError("archive_metadata_size_limit")
        if header_size > directory_offset or payload[30:30 + local_name_size] != central_name:
            raise AuditError("zip_local_header_mismatch")
        if version != entry.extract_version or flags != entry.flag_bits or method != entry.compress_type:
            raise AuditError("zip_local_header_mismatch")
        validate_zip_extra(payload[30 + local_name_size:header_size])
        expected_values = (entry.CRC, entry.compress_size, entry.file_size)
        actual_values = (crc, compressed, expanded)
        if any(actual != expected and not (flags & 8 and actual == 0) for actual, expected in zip(actual_values, expected_values)):
            raise AuditError("zip_local_header_mismatch")
        data_end = header_size + entry.compress_size
        if data_end > directory_offset:
            raise AuditError("zip_overlapping_member")
        descriptor = payload[data_end:directory_offset]
        if flags & 8:
            if descriptor.startswith(b"PK\x07\x08"):
                descriptor = descriptor[4:]
            if len(descriptor) != 12 or struct.unpack("<III", descriptor) != expected_values:
                raise AuditError("invalid_zip_descriptor")
        elif descriptor:
            raise AuditError("trailing_or_hidden_zip_data")
        digest, size, checksum = hashlib.sha256(), 0, 0
        decoder = zlib.decompressobj(-15) if method == zipfile.ZIP_DEFLATED else None
        for offset in range(header_size, data_end, CHUNK):
            chunk = payload[offset:min(offset + CHUNK, data_end)]
            decoded = decoder.decompress(chunk, entry.file_size - size + 1) if decoder else chunk
            size += len(decoded)
            if size > entry.file_size:
                raise AuditError("kernel_executable_size_mismatch")
            if decoder and (decoder.unused_data or decoder.unconsumed_tail):
                raise AuditError("trailing_zip_compressed_data")
            digest.update(decoded)
            checksum = zlib.crc32(decoded, checksum)
        if decoder and not decoder.eof:
            raise AuditError("truncated_zip_member")
        if size != entry.file_size:
            raise AuditError("kernel_executable_size_mismatch")
        if checksum != entry.CRC:
            raise AuditError("zip_crc_mismatch")
        if digest.hexdigest() != artifact["executableSha256"]:
            raise AuditError("kernel_executable_checksum_mismatch")
        return {
            "expandedBytes": size,
            "uncompressedSha256": digest.hexdigest(),
            "executableIdentity": "locked-sha256",
            "inventory": [{"path": name, "type": "file", "size": size, "sha256": digest.hexdigest()}],
        }


def audit_artifact(artifact, path, limits=None):
    limits = LIMITS if limits is None else limits
    # Hash and parse exactly the same immutable, bounded bytes. The caller's file
    # can change while or after being read; it can never change this snapshot.
    payload = read_snapshot(path, limits["compressedBytes"])
    digest = hashlib.sha256(payload).hexdigest()
    if digest != artifact["sha256"]:
        raise AuditError("artifact_checksum_mismatch")
    result = {"id": artifact["id"], "status": "verified", "verifiedScope": "sha256-and-structure", "sha256": digest, "compressedBytes": len(payload), "lockedSource": artifact["url"], "role": artifact["role"], "target": artifact["target"]}
    if artifact["format"] == "zip":
        result.update(scan_kernel_zip(payload, artifact, limits))
        return result, {}
    with gzip.GzipFile(fileobj=io.BytesIO(payload)) as decompressed:
        if artifact["format"] == "tar.gz":
            scan, notices = scan_archive(decompressed, artifact, limits)
            result.update(scan)
            if scan["missingRequiredFiles"]:
                result["status"] = "unverified"
            return result, notices
        reader = LimitedReader(decompressed, limits["memberBytes"])
        unpacked = hashlib.sha256()
        while chunk := reader.read(CHUNK):
            unpacked.update(chunk)
        if not reader.count:
            raise AuditError("empty_kernel_payload")
        result.update({"expandedBytes": reader.count, "uncompressedSha256": unpacked.hexdigest(), "executableIdentity": "unverified"})
        return result, {}


def audit(lock, kernel, supplied):
    validate_lock(lock, kernel)
    expected = {artifact["id"] for artifact in lock["artifacts"]}
    if set(supplied) - expected:
        raise AuditError("unknown_artifact_id")
    results, collected = [], {}
    for artifact in lock["artifacts"]:
        identifier = artifact["id"]
        if identifier not in supplied:
            results.append({"id": identifier, "status": "missing"})
            continue
        try:
            result, notices = audit_artifact(artifact, pathlib.Path(supplied[identifier]))
            collected[identifier] = notices
        except (AuditError, OSError, EOFError, tarfile.TarError, zipfile.BadZipFile, UnicodeError, zlib.error, RecursionError) as error:
            result = {"id": identifier, "status": "invalid", "error": str(error) if isinstance(error, AuditError) else "unreadable_archive"}
        results.append(result)
    # These are verifier capabilities, never assertions accepted from the lock.
    blockers = [
        {"id": "wrapper-source-binding", "status": "missing", "detail": "Exact wrapper source snapshot and its build binding are not supplied by this format."},
        {"id": "generated-ca-binding", "status": "unverified", "detail": "This format has no verifier binding recovered CA bytes to each locked kernel and its generated build inputs."},
        {"id": "corresponding-source-verifier", "status": "unverified", "detail": "Source, vendor, toolchain, build flags and per-target binary correspondence are not verified."},
        {"id": "notice-coverage-review", "status": "unverified", "detail": "Inventory and full notice collection do not prove coverage of linked code, file-level notices or generated CA licensing."},
        {"id": "provenance-verifier", "status": "unverified", "detail": "Authenticated build provenance and artifact signatures are not verified by this auditor."},
    ]
    for result in results:
        if result["status"] != "verified":
            blockers.append({"id": "artifact:" + result["id"], "status": result["status"]})
    return {"schemaVersion": 1, "ready": False, "core": lock["core"], "limits": LIMITS, "artifacts": results, "blockers": blockers}, collected


def collect_notices(destination, report, notices):
    if any(item["status"] == "invalid" for item in report["artifacts"]):
        raise AuditError("invalid_artifact_blocks_collection")
    files = [(identifier, name, data) for identifier, entries in notices.items() for name, data in entries.items()]
    if not files:
        raise AuditError("no_notices_to_collect")
    # A new destination prevents overwrites and archive-controlled symlink reuse.
    destination.mkdir(exist_ok=False)
    manifest = {"schemaVersion": 1, "ready": False, "core": report["core"], "coverage": "unverified", "sourceBinding": "unverified", "artifacts": [], "files": []}
    for identifier, name, data in files:
        relative = identifier + "/" + name
        output = destination.joinpath(*relative.split("/"))
        output.parent.mkdir(parents=True, exist_ok=True)
        with output.open("xb") as stream:
            stream.write(data)
        manifest["files"].append({"artifactId": identifier, "sourcePath": name, "path": relative, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    manifest["artifacts"] = [{key: item[key] for key in ("id", "sha256", "lockedSource", "role")} for item in report["artifacts"] if item["id"] in notices]
    with (destination / "inventory.json").open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(manifest, stream, indent=2, ensure_ascii=True)
        stream.write("\n")
    return {"files": len(files), "coverage": "unverified"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=pathlib.Path, default=ROOT / "distribution-lock.json")
    parser.add_argument("--kernel-lock", type=pathlib.Path, default=ROOT / "kernel-lock.json")
    parser.add_argument("--artifact", action="append", default=[], metavar="ID=PATH")
    parser.add_argument("--collect-notices", type=pathlib.Path, metavar="NEW_DIRECTORY")
    parser.add_argument("--require-ready", action="store_true")
    args = parser.parse_args(argv)
    try:
        supplied = {}
        for value in args.artifact:
            identifier, separator, path = value.partition("=")
            if not separator or not path or identifier in supplied:
                raise AuditError("invalid_artifact_argument")
            supplied[identifier] = path
        report, notices = audit(read_json(args.lock), read_json(args.kernel_lock), supplied)
        if args.collect_notices:
            report["noticeCollection"] = collect_notices(args.collect_notices, report, notices)
        print(json.dumps(report, indent=2, ensure_ascii=True))
        if any(item["status"] == "invalid" for item in report["artifacts"]):
            return 1
        return 2 if args.require_ready and not report["ready"] else 0
    except (AuditError, OSError, ValueError, TypeError, KeyError) as error:
        print(json.dumps({"ready": False, "error": str(error) if isinstance(error, AuditError) else "invalid_audit_input"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
