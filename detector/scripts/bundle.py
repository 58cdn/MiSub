#!/usr/bin/env python3
"""Build-time only: verify the pinned upstream binary before embedding it."""
import argparse
import hashlib
import io
import json
import pathlib
import re
import stat
import struct
import urllib.request
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[1]

def verify_asset(data: bytes, asset: dict) -> None:
    if len(data) > 64 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != asset["sha256"]:
        raise RuntimeError("kernel checksum mismatch; refusing to bundle")
    if asset["file"].endswith(".gz"):
        return
    if not asset["file"].endswith(".zip"):
        raise RuntimeError("unsupported kernel archive")
    entry_name = asset.get("entry", "")
    if not re.fullmatch(r"mihomo-[a-z0-9.-]+\.exe", entry_name):
        raise RuntimeError("invalid kernel entry")
    expected_size = asset.get("executableBytes", 0)
    if not isinstance(expected_size, int) or not 0 < expected_size <= 128 * 1024 * 1024:
        raise RuntimeError("invalid kernel size")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) != 1:
            raise RuntimeError("kernel archive must contain exactly one executable")
        entry = entries[0]
        mode = entry.external_attr >> 16
        if entry.filename != entry_name or entry.is_dir() or entry.flag_bits & 1 or entry.file_size != expected_size or stat.S_IFMT(mode) not in (0, stat.S_IFREG):
            raise RuntimeError("invalid kernel archive entry")
        with archive.open(entry) as reader:
            executable = reader.read(expected_size + 1)
        if len(executable) != expected_size or hashlib.sha256(executable).hexdigest() != asset.get("executableSha256"):
            raise RuntimeError("kernel executable checksum mismatch")
        if len(executable) < 64 or executable[:2] != b"MZ":
            raise RuntimeError("kernel is not a PE executable")
        pe_offset = struct.unpack_from("<I", executable, 60)[0]
        if pe_offset > len(executable) - 26 or executable[pe_offset:pe_offset + 4] != b"PE\x00\x00":
            raise RuntimeError("invalid kernel PE header")
        machine, = struct.unpack_from("<H", executable, pe_offset + 4)
        characteristics, = struct.unpack_from("<H", executable, pe_offset + 22)
        magic, = struct.unpack_from("<H", executable, pe_offset + 24)
        if machine != 0x8664 or magic != 0x20b or not characteristics & 2 or characteristics & 0x2000:
            raise RuntimeError("kernel PE architecture or type mismatch")

def fetch(url: str, maximum: int) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "MiSub-Probe-Build/1"})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise RuntimeError("upstream asset exceeds the build limit")
    return data

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", choices=["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64", "windows-amd64"])
    args = parser.parse_args()
    lock = json.loads((ROOT / "kernel-lock.json").read_text())
    if lock["repository"] != "MetaCubeX/mihomo" or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", lock["version"]):
        raise RuntimeError("invalid upstream lock")
    if not re.fullmatch(r"[0-9a-f]{40}", lock["sourceCommit"]):
        raise RuntimeError("invalid source commit")
    asset = lock["assets"][args.target]
    if not re.fullmatch(r"mihomo-[a-z0-9.-]+\.(gz|zip)", asset["file"]):
        raise RuntimeError("invalid asset name")
    url = f'https://github.com/MetaCubeX/mihomo/releases/download/{lock["version"]}/{asset["file"]}'
    data = fetch(url, 64 * 1024 * 1024)
    verify_asset(data, asset)
    extension = pathlib.PurePosixPath(asset["file"]).suffix
    (ROOT / "embedded" / ("kernel" + extension)).write_bytes(data)
    # A build embeds only its selected, verified platform archive.
    other_extension = ".zip" if extension == ".gz" else ".gz"
    (ROOT / "embedded" / ("kernel" + other_extension)).unlink(missing_ok=True)
    license_text = fetch(f'https://raw.githubusercontent.com/MetaCubeX/mihomo/{lock["sourceCommit"]}/LICENSE', 65536)
    (ROOT / "embedded" / "LICENSE.mihomo").write_bytes(license_text)
    print(f'verified {args.target}: {lock["version"]} sha256={asset["sha256"]}')

if __name__ == "__main__":
    main()
