#!/usr/bin/env python3
"""Build-time only: verify the pinned upstream binary before embedding it."""
import argparse
import hashlib
import json
import pathlib
import re
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]

def fetch(url: str, maximum: int) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "MiSub-Probe-Build/1"})
    with urllib.request.urlopen(request, timeout=90) as response:
        data = response.read(maximum + 1)
    if len(data) > maximum:
        raise RuntimeError("upstream asset exceeds the build limit")
    return data

def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("target", choices=["linux-amd64", "linux-arm64", "darwin-amd64", "darwin-arm64"])
    args = parser.parse_args()
    lock = json.loads((ROOT / "kernel-lock.json").read_text())
    if lock["repository"] != "MetaCubeX/mihomo" or not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", lock["version"]):
        raise RuntimeError("invalid upstream lock")
    if not re.fullmatch(r"[0-9a-f]{40}", lock["sourceCommit"]):
        raise RuntimeError("invalid source commit")
    asset = lock["assets"][args.target]
    if not re.fullmatch(r"mihomo-[a-z0-9.-]+\.gz", asset["file"]):
        raise RuntimeError("invalid asset name")
    url = f'https://github.com/MetaCubeX/mihomo/releases/download/{lock["version"]}/{asset["file"]}'
    data = fetch(url, 64 * 1024 * 1024)
    if hashlib.sha256(data).hexdigest() != asset["sha256"]:
        raise RuntimeError("kernel checksum mismatch; refusing to bundle")
    (ROOT / "embedded" / "kernel.gz").write_bytes(data)
    license_text = fetch(f'https://raw.githubusercontent.com/MetaCubeX/mihomo/{lock["sourceCommit"]}/LICENSE', 65536)
    (ROOT / "embedded" / "LICENSE.mihomo").write_bytes(license_text)
    print(f'verified {args.target}: {lock["version"]} sha256={asset["sha256"]}')

if __name__ == "__main__":
    main()
